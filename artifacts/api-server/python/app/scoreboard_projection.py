"""Refresh only affected scoreboard rows within the award/attempt transaction."""

from sqlalchemy import func, or_, select, text, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    GroupChallengeCredit,
    GroupScoreboard,
    PlayerScoreboard,
    Solve,
    Submission,
)


async def initialize_missing(db: AsyncSession) -> tuple[int, int]:
    """Fill ledger-backed rows omitted by a schema-only deployment.

    Existing rows are left alone unless their totals disagree with the ledgers,
    which happens when a deployment removes an award source without a data migration.

    Run once at startup. Writers and this initializer take the same per-key
    transaction locks before reading totals; keys discovered just before a
    concurrent writer commits are therefore refreshed from committed ledgers.
    """
    player_keys = union_all(
        select(Solve.user_id.label("user_id")),
        select(Submission.user_id).where(Submission.correct.is_(False)),
    ).subquery()
    group_keys = select(GroupChallengeCredit.group_name.label("group_name")).subquery()
    users = set((await db.scalars(
        select(player_keys.c.user_id).distinct()
        .outerjoin(PlayerScoreboard, PlayerScoreboard.user_id == player_keys.c.user_id)
        .where(PlayerScoreboard.user_id.is_(None))
    )).all())
    groups = set((await db.scalars(
        select(group_keys.c.group_name).distinct()
        .outerjoin(GroupScoreboard, GroupScoreboard.group_name == group_keys.c.group_name)
        .where(GroupScoreboard.group_name.is_(None))
    )).all())
    solved = (
        select(Solve.user_id.label("user_id"),
               func.sum(Solve.points_awarded).label("score"), func.count().label("solves"))
        .group_by(Solve.user_id).subquery()
    )
    users |= set((await db.scalars(
        select(PlayerScoreboard.user_id)
        .outerjoin(solved, solved.c.user_id == PlayerScoreboard.user_id)
        .where(or_(PlayerScoreboard.score != func.coalesce(solved.c.score, 0),
                   PlayerScoreboard.solves != func.coalesce(solved.c.solves, 0)))
    )).all())
    credited = (
        select(GroupChallengeCredit.group_name.label("group_name"),
               func.sum(GroupChallengeCredit.points_awarded).label("score"),
               func.count().label("solves"))
        .group_by(GroupChallengeCredit.group_name).subquery()
    )
    groups |= set((await db.scalars(
        select(GroupScoreboard.group_name)
        .outerjoin(credited, credited.c.group_name == GroupScoreboard.group_name)
        .where(or_(GroupScoreboard.score != func.coalesce(credited.c.score, 0),
                   GroupScoreboard.solves != func.coalesce(credited.c.solves, 0)))
    )).all())
    if users or groups:
        await refresh_affected(db, users, groups)
    return len(users), len(groups)


async def refresh_player(db: AsyncSession, user_id: int) -> None:
    await db.flush()
    awards = (
        select(Solve.points_awarded.label("points"), Solve.solved_at.label("at"))
        .where(Solve.user_id == user_id)
    ).subquery()
    total, count, last = (await db.execute(select(
        func.coalesce(func.sum(awards.c.points), 0), func.count(), func.max(awards.c.at),
    ))).one()
    failed = (await db.execute(select(func.count(Submission.id)).where(
        Submission.user_id == user_id, Submission.correct.is_(False),
    ))).scalar_one()
    row = await db.get(PlayerScoreboard, user_id)
    if row is None:
        row = PlayerScoreboard(user_id=user_id)
        db.add(row)
    row.score, row.solves, row.last_solve_at = int(total), int(count), last
    row.failed_attempts = int(failed)


async def refresh_group(db: AsyncSession, name: str) -> None:
    await db.flush()
    awards = (
        select(GroupChallengeCredit.points_awarded.label("points"),
               GroupChallengeCredit.awarded_at.label("at"))
        .where(GroupChallengeCredit.group_name == name)
    ).subquery()
    total, count, last = (await db.execute(select(
        func.coalesce(func.sum(awards.c.points), 0), func.count(), func.max(awards.c.at),
    ))).one()
    row = await db.get(GroupScoreboard, name)
    if count == 0:
        if row is not None:
            await db.delete(row)
        return
    if row is None:
        row = GroupScoreboard(group_name=name)
        db.add(row)
    row.score, row.solves, row.last_solve_at = int(total), int(count), last


async def refresh_affected(
    db: AsyncSession, users: set[int], groups: set[str],
) -> None:
    # Serialize projection updates *before* reading ledger totals. Otherwise two
    # independent award transactions can overwrite one another's snapshot.
    if db.get_bind().dialect.name == "postgresql":
        for user_id in sorted(users):
            await db.execute(
                text("SELECT pg_advisory_xact_lock(1180124755, :key)"),
                {"key": user_id},
            )
        for name in sorted(groups):
            await db.execute(
                text("SELECT pg_advisory_xact_lock(1180124756, hashtext(:name))"),
                {"name": name},
            )
    for user_id in sorted(users):
        await refresh_player(db, user_id)
    for name in sorted(groups):
        await refresh_group(db, name)