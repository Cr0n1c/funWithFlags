from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.activity import drain_request, enqueue, score_message
from app.logging import get_logger
from app.models import (
    AuditLog,
    Challenge,
    GroupChallengeCredit,
    Solve,
    Submission,
)
from app.schemas import (
    ChallengeOut,
    FlagSubmission,
    MatrixCompletionOut,
    SubmitResult,
)
from app.scoreboard_projection import refresh_affected
from app.security import (
    CurrentUser,
    DbDep,
    OptionalUser,
    SettingsDep,
    client_ip,
    user_score,
    verify_flag,
)

router = APIRouter(prefix="/challenges", tags=["challenges"])
log = get_logger(__name__)


@router.get("/notifications", summary="Private committed scoring events")
async def scoring_notifications(
    user: CurrentUser, db: DbDep,
    gold_after: int = Query(default=0, ge=0),
    initialize: bool = False,
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, object]:
    """Read the committed per-player attempt ledger, never score deltas.

    Initialization returns a watermark without history. Subsequent requests page from
    that ID; the cursor survives offline periods and mailbox clears.
    """
    user_id = user.id
    if initialize:
        latest_gold = (await db.execute(
            select(func.coalesce(func.max(AuditLog.id), 0)).where(
                AuditLog.user_id == user_id,
                AuditLog.event_type.in_(("flag_correct", "flag_incorrect")),
            )
        )).scalar_one()
        return {"gold_cursor": latest_gold, "gold": [], "gold_more": False}
    gold_rows = (await db.execute(
        select(AuditLog).where(
            AuditLog.user_id == user_id,
            AuditLog.event_type.in_(("flag_correct", "flag_incorrect")),
            AuditLog.id > gold_after,
        ).order_by(AuditLog.id).limit(limit + 1)
    )).scalars().all()
    gold_events = []
    for row in gold_rows[:limit]:
        detail = row.detail if isinstance(row.detail, dict) else {}
        slug = detail.get("challenge")
        challenge = (await db.execute(
            select(Challenge).where(Challenge.slug == slug)
        )).scalar_one_or_none() if isinstance(slug, str) else None
        points = detail.get("points")
        gold_events.append({
            "id": row.id, "outcome": "incorrect" if row.event_type == "flag_incorrect"
            else "already_solved" if detail.get("already_solved") is True
            or ("already_solved" not in detail and (not isinstance(points, int) or points <= 0))
            else "correct",
            "points": points if isinstance(points, int) and points >= 0 else 0,
            "time": row.created_at.isoformat(),
            # Only a numeric ID: titles, slugs and categories can themselves
            # contain the submitted flag and must not enter mail payloads.
            "challenge_id": challenge.id if challenge else None,
        })
    return {
        "gold_cursor": gold_events[-1]["id"] if gold_events else gold_after,
        "gold_more": len(gold_rows) > limit,
        "gold": gold_events,
    }


async def _solve_counts(db: DbDep) -> dict[int, int]:
    rows = await db.execute(
        select(Solve.challenge_id, func.count(func.distinct(Solve.user_id))).group_by(
            Solve.challenge_id
        )
    )
    return {int(cid): int(n) for cid, n in rows.all()}


async def _solved_ids(db: DbDep, user_id: int) -> set[int]:
    rows = await db.execute(select(Solve.challenge_id).where(Solve.user_id == user_id))
    return {int(r) for r in rows.scalars().all()}


def _to_out(c: Challenge, solved: set[int], counts: dict[int, int]) -> ChallengeOut:
    return ChallengeOut(
        id=c.id,
        slug=c.slug,
        title="<hidden>" if c.hidden else c.title,
        category=c.category,
        description="<hidden>" if c.hidden else c.description,
        points=c.points,
        solved=c.id in solved,
        solve_count=counts.get(c.id, 0),
        hidden=c.hidden,
    )


@router.get(
    "/matrix/status", response_model=MatrixCompletionOut,
    summary="Current player's Matrix completion",
)
async def matrix_completion(user: CurrentUser, db: DbDep) -> MatrixCompletionOut:
    """Read only the authenticated player's committed solve."""
    solved = await db.scalar(select(
        select(Solve.id)
        .join(Challenge, Challenge.id == Solve.challenge_id)
        .where(
            Solve.user_id == user.id,
            Challenge.slug == "enter-the-matrix",
            Challenge.is_active.is_(True),
        )
        .exists()
    ))
    return MatrixCompletionOut(solved=bool(solved))


@router.get("", response_model=list[ChallengeOut], summary="List active challenges")
async def list_challenges(user: OptionalUser, db: DbDep) -> list[ChallengeOut]:
    """Public. `solved` is only meaningful when a session cookie is present."""
    user_id = user.id if user else None
    challenges = (
        (
            await db.execute(
                select(Challenge)
                .where(Challenge.is_active.is_(True))
                .order_by(
                    Challenge.category, Challenge.sort_order, Challenge.points, Challenge.slug
                )
            )
        )
        .scalars()
        .all()
    )
    solved = await _solved_ids(db, user_id) if user_id is not None else set()
    counts = await _solve_counts(db)
    return [_to_out(c, solved, counts) for c in challenges]


async def _get_active(db: DbDep, slug: str) -> Challenge:
    challenge = (
        await db.execute(
            select(Challenge).where(Challenge.slug == slug, Challenge.is_active.is_(True))
        )
    ).scalar_one_or_none()
    if challenge is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=f"No challenge named {slug!r}")
    return challenge


async def _enforce_submit_rate_limit(db: DbDep, user_id: int, settings: SettingsDep) -> None:
    """Apply the shared per-user throttle before resolving or recording an attempt."""
    window_start = datetime.now(UTC) - timedelta(minutes=1)
    recent = (
        await db.execute(
            select(func.count(Submission.id)).where(
                Submission.user_id == user_id, Submission.submitted_at >= window_start
            )
        )
    ).scalar_one()
    if recent >= settings.submit_rate_limit_per_minute:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many submissions. Slow down and try again in a minute.",
        )


async def _resolve_active_flag(
    db: DbDep, settings: SettingsDep, submitted: str
) -> Challenge | None:
    """Return the sole active match; unknown and ambiguous flags resolve to nothing."""
    challenges = (
        (
            await db.execute(select(Challenge).where(Challenge.is_active.is_(True)))
        )
        .scalars()
        .all()
    )
    matches = [
        challenge
        for challenge in challenges
        if verify_flag(
            settings,
            submitted,
            challenge.flag_hash,
            case_sensitive=challenge.case_sensitive,
        )
    ]
    return matches[0] if len(matches) == 1 else None


async def _award_submission(  # noqa: PLR0912
    *,
    request: Request,
    user: CurrentUser,
    db: DbDep,
    challenge: Challenge | None,
    correct: bool,
) -> SubmitResult:
    """Record one attempt and atomically award a first solve and group credits."""
    already = False
    if correct:
        if challenge is None:  # Defensive: unresolved submissions can never award.
            raise RuntimeError("A correct submission must have a resolved challenge")
        already = (
            await db.execute(
                select(Solve.id).where(
                    Solve.user_id == user.id, Solve.challenge_id == challenge.id
                )
            )
        ).scalar_one_or_none() is not None

    db.add(
        Submission(
            user_id=user.id,
            challenge_id=challenge.id if challenge is not None else None,
            correct=correct,
        )
    )

    points_awarded = 0
    if correct and not already and challenge is not None:
        solve = Solve(user_id=user.id, challenge_id=challenge.id, points_awarded=challenge.points)
        try:
            # A savepoint keeps the submission intact if another request wins this user's
            # per-challenge reward concurrently.
            async with db.begin_nested():
                db.add(solve)
                await db.flush()
        except IntegrityError:
            existing_solve = (
                await db.execute(
                    select(Solve.id).where(
                        Solve.user_id == user.id,
                        Solve.challenge_id == challenge.id,
                    )
                )
            ).scalar_one_or_none()
            if existing_solve is None:
                raise
            already = True
        else:
            points_awarded = solve.points_awarded
            # Group names come only from the validated, stored IdP profile. Sort the
            # distinct trimmed names to make concurrent lock acquisition deterministic.
            group_names = sorted(
                {name.strip() for name in user.groups if isinstance(name, str) and name.strip()}
            )
            for group_name in group_names:
                try:
                    # A shared group may already have been credited by another user.
                    # Isolating each insert means that conflict cannot undo this user's
                    # successful solve or prevent another one of their groups earning.
                    async with db.begin_nested():
                        db.add(
                            GroupChallengeCredit(
                                group_name=group_name,
                                challenge_id=challenge.id,
                                points_awarded=solve.points_awarded,
                                credited_by_user_id=user.id,
                            )
                        )
                        await db.flush()
                except IntegrityError:
                    existing_credit = (
                        await db.execute(
                            select(GroupChallengeCredit.id).where(
                                GroupChallengeCredit.group_name == group_name,
                                GroupChallengeCredit.challenge_id == challenge.id,
                            )
                        )
                    ).scalar_one_or_none()
                    if existing_credit is None:
                        raise

    challenge_slug = challenge.slug if challenge is not None else None
    audit = AuditLog(
            user_id=user.id,
            event_type="flag_correct" if correct else "flag_incorrect",
            detail={"challenge": challenge_slug, "points": points_awarded,
                    "already_solved": already},
            ip_address=client_ip(request),
        )
    db.add(audit)
    await db.flush()
    settings = request.app.state.settings
    if points_awarded > 0 and challenge is not None:
        await enqueue(
            db, settings, f"flag:{solve.id}",
            score_message(user, points_awarded,
                          "challenge" if challenge.hidden else challenge.title),
        )
    # Attempt count and any newly credited immutable groups commit with the ledgers.
    await refresh_affected(
        db, {user.id},
        set(group_names) if points_awarded > 0 else set(),
    )
    await db.commit()
    total, _ = await user_score(db, user.id)
    await drain_request(request.app.state.db.session_factory, settings)
    log.info(
        "challenge.submit",
        user_id=user.id,
        challenge=challenge_slug,
        correct=correct,
        points=points_awarded,
    )

    if not correct:
        message = "That is not the flag."
    elif already:
        message = "Correct, but you had already solved this one."
    else:
        message = f"Nice work! +{points_awarded} points."
    return SubmitResult(
        correct=correct,
        already_solved=already,
        points_awarded=points_awarded,
        total_score=total,
        message=message,
        event_id=audit.id,
    )


@router.get("/id/{challenge_id}", response_model=ChallengeOut, summary="Challenge details by ID")
async def get_challenge_by_id(challenge_id: int, user: CurrentUser, db: DbDep) -> ChallengeOut:
    challenge = (
        await db.execute(
            select(Challenge).where(Challenge.id == challenge_id, Challenge.is_active.is_(True))
        )
    ).scalar_one_or_none()
    if challenge is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Challenge not found")
    return _to_out(challenge, await _solved_ids(db, user.id), await _solve_counts(db))


@router.get("/{slug}", response_model=ChallengeOut, summary="Challenge details")
async def get_challenge(slug: str, user: OptionalUser, db: DbDep) -> ChallengeOut:
    challenge = await _get_active(db, slug)
    solved = await _solved_ids(db, user.id) if user else set()
    counts = await _solve_counts(db)
    return _to_out(challenge, solved, counts)


@router.post("/submit", response_model=SubmitResult, summary="Submit a flag")
async def submit_resolved_flag(
    body: FlagSubmission,
    request: Request,
    user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
) -> SubmitResult:
    """Resolve a submitted flag without putting it or a challenge slug in the URL."""
    if len(body.flag) > settings.max_flag_length:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Flag is too long")

    await _enforce_submit_rate_limit(db, user.id, settings)
    challenge = await _resolve_active_flag(db, settings, body.flag)
    return await _award_submission(
        request=request,
        user=user,
        db=db,
        challenge=challenge,
        correct=challenge is not None,
    )


@router.post("/{slug}/submit", response_model=SubmitResult, summary="Submit a flag")
async def submit_flag(
    slug: str,
    body: FlagSubmission,
    request: Request,
    user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
) -> SubmitResult:
    if len(body.flag) > settings.max_flag_length:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Flag is too long")

    challenge = await _get_active(db, slug)
    await _enforce_submit_rate_limit(db, user.id, settings)
    resolved = await _resolve_active_flag(db, settings, body.flag)
    return await _award_submission(
        request=request,
        user=user,
        db=db,
        challenge=challenge,
        correct=resolved is not None and resolved.id == challenge.id,
    )
