"""Real PostgreSQL workers and synthetic ledgers for projection recovery tests."""

import asyncio
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.requests import Request

from app.db import Base
from app.models import (
    AuditLog,
    Challenge,
    GroupChallengeCredit,
    GroupScoreboard,
    PlayerScoreboard,
    Solve,
    Submission,
    User,
)
from app.routers import flag_admin
from app.schemas import FlagDeleteConfirmIn
from app.scoreboard_projection import initialize_missing, refresh_affected
from app.security import encode_flag_delete_token

HISTORICAL = datetime(2026, 1, 1, tzinfo=timezone.utc)
BONUS_AT = datetime(2026, 1, 2, tzinfo=timezone.utc)
GOLD_AT = datetime(2026, 1, 3, tzinfo=timezone.utc)
GROUP_AT = datetime(2026, 1, 4, tzinfo=timezone.utc)
GROUPS = {"Ops", "Security"}


class Workers:
    """Separate engines, sessions and backend PIDs, never the application DB."""

    def __init__(self, url):
        self.url = url
        self.engines = []
        self.pids = {}
        self.owner = self.new_session_factory()

    def new_session_factory(self):
        engine = create_async_engine(
            self.url, pool_size=1, max_overflow=0,
            connect_args={"server_settings": {
                "statement_timeout": "10000", "lock_timeout": "8000",
            }},
        )
        self.engines.append(engine)
        return async_sessionmaker(engine, expire_on_commit=False)

    async def seed(self, *, partial=False, removal=False):
        async with self.engines[0].begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with self.owner.begin() as db:
            db.add_all([
                User(id=i, okta_sub=f"synthetic-{i}", username=f"synthetic-{i}", groups=[])
                for i in (1, 2, 3)
            ])
            db.add_all([
                Challenge(id=i, slug=f"synthetic-{i}", title=f"Synthetic {i}",
                          category="gold", points=points, flag_hash="0" * 64)
                for i, points in ((1, 40), (2, 30), (3, 15), (4, 10))
            ])
            await db.flush()
            db.add_all([
                Solve(user_id=1, challenge_id=1, points_awarded=40, solved_at=HISTORICAL),
                Submission(user_id=2, challenge_id=1, correct=False, submitted_at=HISTORICAL),
                GroupChallengeCredit(group_name="Security", challenge_id=1,
                                     points_awarded=40, awarded_at=HISTORICAL),
                Solve(user_id=1, challenge_id=4, points_awarded=10, solved_at=BONUS_AT),
            ])
            db.add_all([
                GroupChallengeCredit(group_name=name, challenge_id=4,
                                     points_awarded=10, awarded_at=BONUS_AT)
                for name in sorted(GROUPS)
            ])
            if partial:
                db.add(PlayerScoreboard(user_id=2, score=0, solves=0, failed_attempts=1))
            if removal:
                # Exercise a player's final solve and a group whose only credit
                # belongs to the challenge being deleted.
                db.add(Solve(user_id=3, challenge_id=1, points_awarded=40,
                             solved_at=HISTORICAL))
                db.add(GroupChallengeCredit(group_name="GoldOnly", challenge_id=1,
                                             points_awarded=40, awarded_at=HISTORICAL))
                if partial:
                    db.add(GroupScoreboard(group_name="GoldOnly", score=40, solves=1,
                                           last_solve_at=HISTORICAL))

    async def run(self, name, operation, *, ready=None, release=None, before_commit=None):
        factory = self.new_session_factory()
        async with factory.begin() as db:
            self.pids[name] = await db.scalar(text("SELECT pg_backend_pid()"))
            assert await db.scalar(text("SHOW transaction_isolation")) == "read committed"
            result = await operation(db)
            await db.flush()
            if before_commit is not None:
                # Test-only transaction barrier: inspect persisted, uncommitted
                # writes on this session, then interrupt before context commit.
                await before_commit(db, result)
            if ready is not None:
                ready.set()
                await release.wait()
        return result

    async def close(self):
        for engine in self.engines:
            await engine.dispose()


async def gold_solve(db):
    # Includes a previously unseen player and group: discovery cannot find them,
    # so the concurrent writer must create their projection rows itself.
    for user_id in (1, 3):
        db.add(Solve(user_id=user_id, challenge_id=2, points_awarded=30, solved_at=GOLD_AT))
        db.add(Submission(user_id=user_id, challenge_id=2, correct=True, submitted_at=GOLD_AT))
    for name in ("Security", "NewGroup"):
        db.add(GroupChallengeCredit(group_name=name, challenge_id=2,
                                   points_awarded=30, awarded_at=GOLD_AT))
    await db.flush()
    await refresh_affected(db, {3, 1}, {"Security", "NewGroup"})


async def failed_attempts(db):
    for user_id in (2, 1):
        db.add(Submission(user_id=user_id, challenge_id=2, correct=False,
                          submitted_at=GROUP_AT))
    await db.flush()
    await refresh_affected(db, {2, 1}, set())


async def award_adjustment(db):
    solve = await db.scalar(select(Solve).where(Solve.challenge_id == 4))
    solve.points_awarded = 25
    for credit in (await db.scalars(select(GroupChallengeCredit).where(
        GroupChallengeCredit.challenge_id == 4,
    ))).all():
        credit.points_awarded = 25
    await db.flush()
    await refresh_affected(db, {1}, GROUPS)


async def group_credits(db):
    db.add_all([
        GroupChallengeCredit(group_name="Ops", challenge_id=2,
                             points_awarded=30, awarded_at=GROUP_AT),
        GroupChallengeCredit(group_name="Security", challenge_id=3,
                             points_awarded=15, awarded_at=GROUP_AT),
    ])
    await db.flush()
    await refresh_affected(db, set(), {"Security", "Ops"})


async def delete_confirmed_flag(db, settings):
    challenge = await db.get(Challenge, 1)
    user = await db.get(User, 1)
    # Call the actual handler, including version-bound confirmation, cascades,
    # projection refresh, audit, and its own commit.
    return await flag_admin.delete_flag(
        challenge.slug,
        FlagDeleteConfirmIn(
            confirmation_token=encode_flag_delete_token(settings, user.id, challenge),
        ),
        Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1)}),
        user, db, settings,
    )

async def remove_with_commit_hook(db, settings, monkeypatch, before_commit):
    """Test-only interruption boundary after the real removal, before its commit."""
    # The handler owns its commit. Patch only this writer session, keeping
    # recovery sessions and production code free of injection switches.
    commit = db.commit

    async def controlled_commit():
        await before_commit()
        await commit()

    with monkeypatch.context() as patch:
        patch.setattr(db, "commit", controlled_commit)
        await delete_confirmed_flag(db, settings)


async def assert_writer_blocks_recovery(observer, workers, names, *, writer="writer"):
    """Each waiter is blocked on an advisory key actually held by the writer."""
    for name in names:
        assert await observer.scalar(text(
            "SELECT EXISTS (SELECT 1 FROM pg_locks waiting "
            "JOIN pg_locks held ON held.locktype = waiting.locktype "
            "AND held.database = waiting.database AND held.classid = waiting.classid "
            "AND held.objid = waiting.objid AND held.objsubid = waiting.objsubid "
            "WHERE waiting.locktype = 'advisory' AND NOT waiting.granted "
            "AND waiting.pid = :waiter AND held.granted AND held.pid = :writer "
            "AND :writer = ANY(pg_blocking_pids(:waiter)))"
        ), {"waiter": workers.pids[name], "writer": workers.pids[writer]})


async def assert_recovery_holds_players_waiting_for_group(
    observer, workers, name, *, partial,
):
    """Prove partial lock acquisition, not merely a wait on the first player."""
    locks = await advisory_locks(observer, workers, [name])
    # pg_locks exposes the signed hashtext key as an unsigned OID.
    ops_key = await observer.scalar(text(
        "SELECT hashtext('Ops')::bigint & 4294967295"
    ))
    expected = {
        (1180124755, user_id, 2, "ExclusiveLock", True)
        for user_id in ([1] if partial else [1, 2])
    }
    expected.add((1180124756, ops_key, 2, "ExclusiveLock", False))
    assert {
        (row.classid, row.objid, row.objsubid, row.mode, row.granted) for row in locks
    } == expected
    await assert_writer_blocks_recovery(observer, workers, [name])


async def advisory_locks(observer, workers, names):
    """Include granted AND waiting locks, using the original backend PIDs."""
    return (await observer.execute(text(
        "SELECT pid, database, classid, objid, objsubid, mode, granted "
        "FROM pg_locks WHERE locktype = 'advisory' AND pid = ANY(:pids) "
        "ORDER BY pid, database, classid, objid, objsubid, mode, granted"
    ), {"pids": [workers.pids[name] for name in names]})).all()


async def wait_for_no_advisory_locks(observer, workers, names):
    # asyncpg may finish terminating a cancelled connection just after its task
    # exits. Observe that cleanup, bounded independently of the lock timeout.
    async with asyncio.timeout(5):
        while await advisory_locks(observer, workers, names):
            await asyncio.sleep(0.01)


async def wait_for_advisory_waiters(observer, workers, names, tasks):
    """Wait for observed PostgreSQL contention, not a lucky scheduler sleep."""
    async with asyncio.timeout(5):
        while True:
            for task in tasks:
                if task.done():
                    # Surface DB exceptions rather than hiding them behind a timeout.
                    task.result()
                    raise AssertionError("Worker completed without the required contention")
            pids = set((await observer.scalars(text(
                "SELECT DISTINCT pid FROM pg_locks "
                "WHERE locktype = 'advisory' AND NOT granted"
            ))).all())
            if (all(name in workers.pids for name in names)
                    and {workers.pids[name] for name in names} <= pids):
                assert len(set(workers.pids.values())) == len(workers.pids)
                return
            await asyncio.sleep(0.01)


async def cancel_workers(tasks):
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def snapshot_records(db, models):
    """Read every persisted column, avoiding stale ORM identity-map objects."""
    result = {}
    for model in models:
        table = model.__table__
        result[table.name] = [
            dict(row) for row in (await db.execute(
                select(table).order_by(*table.primary_key.columns)
            )).mappings()
        ]
    return result


async def assert_committed_totals(
    workers, *, writes=False, removal=False, rolled_back=False, group_player_writes=False,
):
    """Independent Python ledger oracle plus exact expected synthetic totals."""
    async with workers.owner() as db:
        solves = (await db.scalars(select(Solve))).all()
        attempts = (await db.scalars(select(Submission))).all()
        credits = (await db.scalars(select(GroupChallengeCredit))).all()
        counts = (4, 5, 7) if writes else (2, 1, 3)
        if group_player_writes:
            assert not writes and not removal and not rolled_back
            counts = (2, 3, 5)
        if rolled_back:
            assert removal
            counts = (3, 1, 4)
            assert await db.get(Challenge, 1) is not None
            assert not (await db.scalars(select(AuditLog))).all()
        elif removal:
            counts = (1, 0, 2)
            assert await db.get(Challenge, 1) is None
            audit = (await db.scalars(select(AuditLog))).one()
            assert audit.event_type == "flag_admin_challenge_deleted"
        assert (len(solves), len(attempts), len(credits)) == counts
        # Player rows remain at zero after the last ledger entry is removed;
        # unlike group rows, they are not deleted by refresh_player.
        players = {i: [0, 0, None, 0] for i in (1, 2, 3)} if removal else {}
        groups = {}

        def award(rows, key, points, at, *, player=False):
            row = rows.setdefault(key, [0, 0, None, 0] if player else [0, 0, None])
            row[0] += points
            row[1] += 1
            row[2] = max(filter(None, (row[2], at)), default=None)

        for solve in solves:
            award(players, solve.user_id, solve.points_awarded, solve.solved_at, player=True)
        for attempt in attempts:
            if not attempt.correct:
                players.setdefault(attempt.user_id, [0, 0, None, 0])[3] += 1
        for credit in credits:
            award(groups, credit.group_name, credit.points_awarded, credit.awarded_at)
        actual_players = {
            row.user_id: [row.score, row.solves, row.last_solve_at, row.failed_attempts]
            for row in (await db.scalars(select(PlayerScoreboard))).all()
        }
        actual_groups = {
            row.group_name: [row.score, row.solves, row.last_solve_at]
            for row in (await db.scalars(select(GroupScoreboard))).all()
        }
        assert actual_players == players, (actual_players, players)
        assert actual_groups == groups, (actual_groups, groups)
        expected_players = ({
            1: [95, 3, GOLD_AT, 1], 2: [0, 0, None, 2], 3: [30, 1, GOLD_AT, 0],
        } if writes else {1: [50, 2, BONUS_AT, 0], 2: [0, 0, None, 1]})
        expected_groups = ({
            "Security": [110, 4, GROUP_AT], "Ops": [55, 2, GROUP_AT],
            "NewGroup": [30, 1, GOLD_AT],
        } if writes else {"Security": [50, 2, BONUS_AT], "Ops": [10, 1, BONUS_AT]})
        if group_player_writes:
            expected_players = {
                1: [50, 2, BONUS_AT, 1], 2: [0, 0, None, 2],
            }
            expected_groups = {
                "Security": [65, 3, GROUP_AT], "Ops": [40, 2, GROUP_AT],
            }
        if rolled_back:
            expected_players[3] = [40, 1, HISTORICAL, 0]
            expected_groups["GoldOnly"] = [40, 1, HISTORICAL]
        elif removal:
            expected_players = {
                1: [10, 1, BONUS_AT, 0], 2: [0, 0, None, 0], 3: [0, 0, None, 0],
            }
            expected_groups = {"Security": [10, 1, BONUS_AT], "Ops": [10, 1, BONUS_AT]}
        assert actual_players == expected_players
        assert actual_groups == expected_groups
    # A new transaction after recovery is idempotent; check before any repair can
    # hide a missing/incorrect row, then verify the no-op leaves totals unchanged.
    async with workers.owner.begin() as db:
        assert await initialize_missing(db) == (0, 0)
    async with workers.owner() as db:
        assert {
            row.user_id: [row.score, row.solves, row.last_solve_at, row.failed_attempts]
            for row in (await db.scalars(select(PlayerScoreboard))).all()
        } == actual_players
        assert {
            row.group_name: [row.score, row.solves, row.last_solve_at]
            for row in (await db.scalars(select(GroupScoreboard))).all()
        } == actual_groups
