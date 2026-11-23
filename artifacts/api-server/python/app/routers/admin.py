"""Admin API. Gated on Okta group membership (ADMIN_GROUPS)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.logging import get_logger
from app.models import (
    AuditLog,
    Challenge,
    GroupChallengeCredit,
    Solve,
    Submission,
    User,
)
from app.routers.leaderboard import combined_rankings
from app.schemas import (
    AdminChallengeOut,
    AdminUserOut,
    AuditOut,
    ChallengeUpsert,
    SubmissionOut,
)
from app.scoreboard_projection import refresh_affected
from app.security import (
    AdminUser,
    DbDep,
    FlagAdminUser,
    SettingsDep,
    acquire_flag_mutation_lock,
    client_ip,
    has_app_admin_access,
    hash_flag,
    verify_flag,
)
from app.seed import SLUG_RE
from app.user_points import UserPointsImport, UserPointsResult, import_user_points

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/user-points/import", response_model=UserPointsResult)
async def award_user_points(
    body: UserPointsImport,
    response: Response,
    admin: FlagAdminUser,
    db: DbDep,
):
    response.headers["Cache-Control"] = "private, no-store"
    result = await import_user_points(db, admin.id, body)
    if not body.preview:
        await db.commit()
    return result


class UserStatsOut(BaseModel):
    people_logged_in: int
    people_with_points: int
    average_daily_logins: float
    window_days: int
    window_start: str
    window_end: str
    timezone: str


@router.get("/user-stats", response_model=UserStatsOut)
async def user_stats(_admin: AdminUser, db: DbDep):
    """Aggregate stored activity and awards; never trigger scoring."""
    end = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=30)
    # Explicit UTC conversion on PostgreSQL, independent of the DB session timezone.
    timestamp = AuditLog.created_at
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        timestamp = func.timezone("UTC", timestamp)
    daily = (
        select(func.count(func.distinct(AuditLog.user_id)).label("people"))
        .where(
            AuditLog.event_type == "saml.login",
            AuditLog.created_at >= start,
            AuditLog.created_at < end,
            AuditLog.user_id.is_not(None),
        )
        .group_by(func.date(timestamp))
        .subquery()
    )
    total_user_days = await db.scalar(select(func.coalesce(func.sum(daily.c.people), 0)))
    logged_in = await db.scalar(select(func.count(User.id)).where(User.last_login_at.is_not(None)))
    # Statistics include competition opt-outs; hiding a rank is not removing a user.
    rankings = await combined_rankings(db)
    return UserStatsOut(
        people_logged_in=int(logged_in or 0),
        people_with_points=sum(row.score > 0 for _, row in rankings),
        average_daily_logins=round(float(total_user_days or 0) / 30, 2),
        window_days=30,
        window_start=start.date().isoformat(),
        window_end=(end - timedelta(days=1)).date().isoformat(),
        timezone="UTC",
    )


log = get_logger(__name__)


def _audit(db: DbDep, request: Request, admin: User, event: str, **detail: object) -> None:
    db.add(
        AuditLog(user_id=admin.id, event_type=event, detail=detail, ip_address=client_ip(request))
    )


@router.get("/challenges", response_model=list[AdminChallengeOut])
async def list_challenges(admin: AdminUser, db: DbDep) -> list[AdminChallengeOut]:
    rows = await db.execute(
        select(Solve.challenge_id, func.count(Solve.id)).group_by(Solve.challenge_id)
    )
    counts = {int(cid): int(n) for cid, n in rows.all()}
    challenges = (
        await db.execute(select(Challenge).order_by(Challenge.category, Challenge.sort_order))
    ).scalars()
    return [
        AdminChallengeOut.model_validate(c).model_copy(update={"solve_count": counts.get(c.id, 0)})
        for c in challenges
    ]


@router.put(
    "/challenges/{slug}", response_model=AdminChallengeOut, summary="Create or update a challenge"
)
async def upsert_challenge(
    slug: str,
    body: ChallengeUpsert,
    request: Request,
    admin: FlagAdminUser,
    db: DbDep,
    settings: SettingsDep,
) -> AdminChallengeOut:
    await acquire_flag_mutation_lock(db)
    if not SLUG_RE.match(slug):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Invalid slug")
    challenge = (
        await db.execute(select(Challenge).where(Challenge.slug == slug))
    ).scalar_one_or_none()
    created = challenge is None
    if challenge is None:
        if body.flag is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="A flag is required for a new challenge",
            )
        challenge = Challenge(slug=slug, flag_hash="")
        db.add(challenge)

    challenge.title = body.title
    challenge.category = body.category
    challenge.description = body.description
    challenge.points = body.points
    challenge.case_sensitive = body.case_sensitive
    challenge.is_active = body.is_active
    challenge.sort_order = body.sort_order
    if body.flag is not None:
        candidates = (await db.execute(select(Challenge))).scalars().all()
        if any(
            candidate.id != challenge.id
            and verify_flag(
                settings,
                body.flag,
                candidate.flag_hash,
                case_sensitive=candidate.case_sensitive,
            )
            for candidate in candidates
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, detail="Flag already exists")
        challenge.flag_hash = hash_flag(settings, body.flag, case_sensitive=body.case_sensitive)

    _audit(
        db,
        request,
        admin,
        "admin_challenge_created" if created else "admin_challenge_updated",
        slug=slug,
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Flag already exists") from None
    await db.refresh(challenge)
    log.info("admin.challenge_upsert", admin=admin.username, slug=slug, created=created)
    return AdminChallengeOut.model_validate(challenge)


@router.delete("/challenges/{slug}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_challenge(slug: str, request: Request, admin: FlagAdminUser, db: DbDep) -> None:
    challenge = (
        await db.execute(select(Challenge).where(Challenge.slug == slug))
    ).scalar_one_or_none()
    if challenge is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Not found")
    users = set(
        (
            await db.execute(select(Solve.user_id).where(Solve.challenge_id == challenge.id))
        ).scalars()
    )
    groups = set(
        (
            await db.execute(
                select(GroupChallengeCredit.group_name).where(
                    GroupChallengeCredit.challenge_id == challenge.id,
                )
            )
        ).scalars()
    )
    await db.delete(challenge)
    await db.flush()
    await refresh_affected(db, users, groups)
    _audit(db, request, admin, "admin_challenge_deleted", slug=slug)
    await db.commit()


@router.get("/users", response_model=list[AdminUserOut])
async def list_users(admin: AdminUser, db: DbDep) -> list[AdminUserOut]:
    score = func.coalesce(func.sum(Solve.points_awarded), 0)
    rows = await db.execute(
        select(User, score, func.count(Solve.id))
        .outerjoin(Solve, Solve.user_id == User.id)
        .group_by(User.id)
        .order_by(score.desc(), User.username)
    )
    return [
        AdminUserOut(
            id=user.id,
            username=user.username,
            email=user.email,
            full_name=user.full_name,
            groups=user.groups,
            is_admin=has_app_admin_access(user),
            is_active=user.is_active,
            created_at=user.created_at,
            last_login_at=user.last_login_at,
            score=int(total),
            solves=int(n),
        )
        for user, total, n in rows.all()
    ]


@router.get("/audit", response_model=list[AuditOut])
async def audit(
    admin: AdminUser,
    db: DbDep,
    limit: int = Query(default=100, ge=1, le=1000),
    event_type: str | None = None,
) -> list[AuditOut]:
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit)
    if event_type:
        stmt = stmt.where(AuditLog.event_type == event_type)
    return [AuditOut.model_validate(a) for a in (await db.execute(stmt)).scalars()]


@router.get("/submissions", response_model=list[SubmissionOut])
async def submissions(
    admin: AdminUser, db: DbDep, limit: int = Query(default=100, ge=1, le=1000)
) -> list[SubmissionOut]:
    rows = await db.execute(
        select(
            Submission.id,
            User.username,
            Challenge.slug,
            Submission.correct,
            Submission.submitted_at,
        )
        .join(User, User.id == Submission.user_id)
        .outerjoin(Challenge, Challenge.id == Submission.challenge_id)
        .order_by(Submission.submitted_at.desc(), Submission.id.desc())
        .limit(limit)
    )
    return [
        SubmissionOut(id=i, username=u, challenge_slug=s, correct=c, submitted_at=t)
        for i, u, s, c, t in rows.all()
    ]
