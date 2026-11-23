"""Explicit personal challenge credit, using the same unique solve ledger as flags."""

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog, Challenge, Solve, User
from app.scoreboard_projection import refresh_affected
from app.security import acquire_flag_mutation_lock


class UserPointsImport(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    user: str = Field(min_length=1, max_length=255)
    challenge: str = Field(min_length=1, max_length=63, pattern=r"^[a-z0-9][a-z0-9-]*$")
    preview: bool = False


class UserPointsResult(BaseModel):
    user_id: int
    display_name: str
    challenge: str
    title: str
    points: int
    points_awarded: int
    already_awarded: bool
    preview: bool


async def import_user_points(
    db: AsyncSession, actor_id: int, body: UserPointsImport,
) -> UserPointsResult:
    # Share the flag administration lock so challenge edits/deletions cannot
    # change the value between validation and commit. Preview reserves nothing.
    if not body.preview:
        await acquire_flag_mutation_lock(db)
    query = select(User).where(or_(
        func.lower(User.username) == body.user.lower(),
        func.lower(func.trim(User.full_name)) == body.user.lower(),
    )).limit(2)
    if not body.preview:
        query = query.with_for_update()
    users = (await db.scalars(query)).all()
    if not users:
        raise HTTPException(404, "No matching account. The recipient must sign in first.")
    if len(users) != 1:
        raise HTTPException(409, "More than one account matches. Use the exact username.")
    user = users[0]
    if not user.is_active:
        raise HTTPException(409, "The recipient account is disabled.")
    challenge = await db.scalar(select(Challenge).where(Challenge.slug == body.challenge))
    if challenge is None:
        raise HTTPException(404, "Challenge not found. Import the challenge first.")
    if not challenge.is_active or challenge.category.lower() not in {
        "gold", "owasp", "cracking", "talks", "intro",
    }:
        raise HTTPException(409, "Only active Gold-track challenges can be awarded.")
    existing_query = select(Solve).where(
        Solve.user_id == user.id, Solve.challenge_id == challenge.id,
    )
    existing = await db.scalar(existing_query)
    points_awarded = 0
    if not body.preview and existing is None:
        try:
            # The unique (user, challenge) key also protects against a concurrent
            # normal flag submission, not just another administrator import.
            async with db.begin_nested():
                db.add(Solve(user_id=user.id, challenge_id=challenge.id,
                             points_awarded=challenge.points))
                await db.flush()
        except IntegrityError:
            existing = await db.scalar(existing_query)
            if existing is None:
                raise
        else:
            points_awarded = challenge.points
            db.add(AuditLog(
                user_id=actor_id, event_type="user_points_imported",
                detail={"recipient_user_id": user.id, "challenge_id": challenge.id,
                        "points": points_awarded, "personal_credit_only": True},
            ))
            # A historical personal award does not establish past IdP group
            # membership. Never infer or backfill group credit from today's profile.
            await refresh_affected(db, {user.id}, set())
    return UserPointsResult(
        user_id=user.id, display_name=user.full_name or user.username,
        challenge=challenge.slug, title=challenge.title,
        points=existing.points_awarded if existing else challenge.points,
        points_awarded=points_awarded, already_awarded=existing is not None,
        preview=body.preview,
    )
