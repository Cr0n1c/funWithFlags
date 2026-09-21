from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.logging import get_logger
from app.models import AuditLog, Challenge, Solve, Submission
from app.schemas import ChallengeOut, FlagSubmission, SubmitResult
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


async def _solve_counts(db: DbDep) -> dict[int, int]:
    rows = await db.execute(
        select(Solve.challenge_id, func.count(Solve.id)).group_by(Solve.challenge_id)
    )
    return {int(cid): int(n) for cid, n in rows.all()}


async def _solved_ids(db: DbDep, user_id: int) -> set[int]:
    rows = await db.execute(select(Solve.challenge_id).where(Solve.user_id == user_id))
    return {int(r) for r in rows.scalars().all()}


def _to_out(c: Challenge, solved: set[int], counts: dict[int, int]) -> ChallengeOut:
    return ChallengeOut(
        slug=c.slug,
        title=c.title,
        category=c.category,
        description=c.description,
        points=c.points,
        solved=c.id in solved,
        solve_count=counts.get(c.id, 0),
    )


@router.get("", response_model=list[ChallengeOut], summary="List active challenges")
async def list_challenges(user: OptionalUser, db: DbDep) -> list[ChallengeOut]:
    """Public. `solved` is only meaningful when a session cookie is present."""
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
    solved = await _solved_ids(db, user.id) if user else set()
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


@router.get("/{slug}", response_model=ChallengeOut, summary="Challenge details")
async def get_challenge(slug: str, user: OptionalUser, db: DbDep) -> ChallengeOut:
    challenge = await _get_active(db, slug)
    solved = await _solved_ids(db, user.id) if user else set()
    counts = await _solve_counts(db)
    return _to_out(challenge, solved, counts)


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

    # Per-user throttle, counted in the DB so it holds across replicas without Redis.
    window_start = datetime.now(UTC) - timedelta(minutes=1)
    recent = (
        await db.execute(
            select(func.count(Submission.id)).where(
                Submission.user_id == user.id, Submission.submitted_at >= window_start
            )
        )
    ).scalar_one()
    if recent >= settings.submit_rate_limit_per_minute:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many submissions. Slow down and try again in a minute.",
        )

    already = (
        await db.execute(
            select(Solve.id).where(Solve.user_id == user.id, Solve.challenge_id == challenge.id)
        )
    ).scalar_one_or_none() is not None

    correct = verify_flag(
        settings, body.flag, challenge.flag_hash, case_sensitive=challenge.case_sensitive
    )
    db.add(Submission(user_id=user.id, challenge_id=challenge.id, correct=correct))

    points_awarded = 0
    if correct and not already:
        db.add(Solve(user_id=user.id, challenge_id=challenge.id, points_awarded=challenge.points))
        try:
            await db.flush()
            points_awarded = challenge.points
        except IntegrityError:
            # Two tabs racing: the other one won. Treat as already solved.
            await db.rollback()
            db.add(Submission(user_id=user.id, challenge_id=challenge.id, correct=True))
            already = True

    db.add(
        AuditLog(
            user_id=user.id,
            event_type="flag_correct" if correct else "flag_incorrect",
            detail={"challenge": challenge.slug, "points": points_awarded},
            ip_address=client_ip(request),
        )
    )
    await db.commit()
    total, _ = await user_score(db, user.id)
    log.info(
        "challenge.submit",
        user_id=user.id,
        challenge=challenge.slug,
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
    )
