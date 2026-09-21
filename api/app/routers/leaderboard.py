from __future__ import annotations

from fastapi import APIRouter, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Solve, User
from app.schemas import LeaderboardEntry, MyRank
from app.security import CurrentUser, DbDep

router = APIRouter(tags=["leaderboard"])


async def _ranked(db: AsyncSession) -> list[LeaderboardEntry]:
    """Every active player with at least one solve, best first.

    Ties are broken by who reached the score first, then by username. Computed in full because a
    CTF has hundreds of players at most; slicing happens in the callers.
    """
    score = func.coalesce(func.sum(Solve.points_awarded), 0).label("score")
    solves = func.count(Solve.id).label("solves")
    last = func.max(Solve.solved_at).label("last_solve_at")
    rows = await db.execute(
        select(User.username, User.full_name, score, solves, last)
        .join(Solve, Solve.user_id == User.id)
        .where(User.is_active.is_(True))
        .group_by(User.id, User.username, User.full_name)
        .order_by(score.desc(), last.asc(), User.username.asc())
    )
    return [
        LeaderboardEntry(
            rank=i,
            username=username,
            full_name=full_name,
            score=int(total),
            solves=int(n),
            last_solve_at=last_at,
        )
        for i, (username, full_name, total, n, last_at) in enumerate(rows.all(), start=1)
    ]


@router.get("/leaderboard", response_model=list[LeaderboardEntry], summary="Top players")
async def leaderboard(
    db: DbDep, limit: int = Query(default=10, ge=1, le=200)
) -> list[LeaderboardEntry]:
    return (await _ranked(db))[:limit]


@router.get("/leaderboard/me", response_model=MyRank, summary="Where the current player stands")
async def my_rank(user: CurrentUser, db: DbDep) -> MyRank:
    ranked = await _ranked(db)
    mine = next((e for e in ranked if e.username == user.username), None)
    if mine is None:
        # No solves yet: unranked, but still tell the UI who they are.
        mine = LeaderboardEntry(
            rank=None,
            username=user.username,
            full_name=user.full_name,
            score=0,
            solves=0,
            last_solve_at=None,
        )
    return MyRank(entry=mine, total_players=len(ranked))
