"""Admin API. Gated on Okta group membership (ADMIN_GROUPS)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, select

from app.logging import get_logger
from app.models import AuditLog, Challenge, Solve, Submission, User
from app.schemas import AdminChallengeOut, AdminUserOut, AuditOut, ChallengeUpsert, SubmissionOut
from app.security import AdminUser, DbDep, SettingsDep, client_ip, hash_flag
from app.seed import SLUG_RE

router = APIRouter(prefix="/admin", tags=["admin"])
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
    admin: AdminUser,
    db: DbDep,
    settings: SettingsDep,
) -> AdminChallengeOut:
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
        challenge.flag_hash = hash_flag(settings, body.flag, case_sensitive=body.case_sensitive)

    _audit(
        db,
        request,
        admin,
        "admin_challenge_created" if created else "admin_challenge_updated",
        slug=slug,
    )
    await db.commit()
    await db.refresh(challenge)
    log.info("admin.challenge_upsert", admin=admin.username, slug=slug, created=created)
    return AdminChallengeOut.model_validate(challenge)


@router.delete("/challenges/{slug}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_challenge(slug: str, request: Request, admin: AdminUser, db: DbDep) -> None:
    challenge = (
        await db.execute(select(Challenge).where(Challenge.slug == slug))
    ).scalar_one_or_none()
    if challenge is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Not found")
    await db.delete(challenge)
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
            is_admin=user.is_admin,
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
        .join(Challenge, Challenge.id == Submission.challenge_id)
        .order_by(Submission.submitted_at.desc(), Submission.id.desc())
        .limit(limit)
    )
    return [
        SubmissionOut(id=i, username=u, challenge_slug=s, correct=c, submitted_at=t)
        for i, u, s, c, t in rows.all()
    ]
