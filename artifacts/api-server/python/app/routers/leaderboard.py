from __future__ import annotations

from fastapi import APIRouter, Query, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import GroupScoreboard, PlayerScoreboard, User
from app.schemas import GroupLeaderboardEntry, LeaderboardEntry, MyRank
from app.security import CurrentUser, DbDep, SettingsDep, user_score

router = APIRouter(tags=["leaderboard"])


async def combined_rankings(db: AsyncSession, excluded_subjects: list[str] | None = None):
    rows = (
        await db.execute(
            select(
                func.row_number()
                .over(
                    order_by=(
                        PlayerScoreboard.score.desc(),
                        PlayerScoreboard.last_solve_at.asc(),
                        User.username.asc(),
                    )
                )
                .label("rank"),
                User.id,
                User.username,
                User.full_name,
                PlayerScoreboard.score,
                PlayerScoreboard.solves,
                PlayerScoreboard.failed_attempts,
                PlayerScoreboard.last_solve_at,
            )
            .join(User, User.id == PlayerScoreboard.user_id)
            .where(User.is_active.is_(True), PlayerScoreboard.solves > 0)
            .order_by(
                PlayerScoreboard.score.desc(),
                PlayerScoreboard.last_solve_at.asc(),
                User.username.asc(),
            )
        )
    ).all()
    rankings = [
        (
            user_id,
            LeaderboardEntry(
                rank=rank,
                username=username,
                full_name=full_name,
                score=score,
                solves=solves,
                failed_attempts=failed,
                last_solve_at=last_at,
            ),
        )
        for rank, user_id, username, full_name, score, solves, failed, last_at in rows
    ]
    if excluded_subjects:
        excluded_ids = set(
            await db.scalars(select(User.id).where(User.okta_sub.in_(excluded_subjects)))
        )
        # Re-rank before applying the requested limit.
        rankings = [(user_id, entry) for user_id, entry in rankings if user_id not in excluded_ids]
        for rank, (_, entry) in enumerate(rankings, 1):
            entry.rank = rank
    return rankings


@router.get("/leaderboard", response_model=list[LeaderboardEntry], summary="Top players")
async def leaderboard(
    request: Request,
    _user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
    limit: int = Query(default=10, ge=1, le=200),
) -> list[LeaderboardEntry]:
    return [
        entry
        for _, entry in (await combined_rankings(db, settings.scoreboard_excluded_subjects))[:limit]
    ]


@router.get(
    "/leaderboard/groups",
    response_model=list[GroupLeaderboardEntry],
    summary="Top IdP groups",
)
async def group_leaderboard(
    _user: CurrentUser,
    db: DbDep,
    limit: int = Query(default=100, ge=1, le=200),
    *,
    request: Request,
) -> list[GroupLeaderboardEntry]:
    """Rank immutable group award ledger entries, never current user memberships."""
    rows = (
        (
            await db.execute(
                select(GroupScoreboard)
                .order_by(
                    GroupScoreboard.score.desc(),
                    GroupScoreboard.last_solve_at.asc(),
                    GroupScoreboard.group_name.asc(),
                )
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [
        GroupLeaderboardEntry(
            rank=i,
            group_name=row.group_name,
            score=row.score,
            solves=row.solves,
            last_solve_at=row.last_solve_at,
        )
        for i, row in enumerate(rows, start=1)
    ]


@router.get("/leaderboard/me", response_model=MyRank, summary="Where the current player stands")
async def my_rank(request: Request, user: CurrentUser, db: DbDep, settings: SettingsDep) -> MyRank:
    rankings = await combined_rankings(db, settings.scoreboard_excluded_subjects)
    mine = next((entry for key, entry in rankings if key == user.id), None)
    if mine is None:
        row = await db.get(PlayerScoreboard, user.id)
        # Being outside the competition does not erase personal progress.
        score, solves = await user_score(db, user.id)
        mine = LeaderboardEntry(
            rank=None,
            username=user.username,
            full_name=user.full_name,
            score=score,
            solves=solves,
            failed_attempts=row.failed_attempts if row else 0,
            last_solve_at=row.last_solve_at if row else None,
        )
    return MyRank(entry=mine, total_players=len(rankings))
