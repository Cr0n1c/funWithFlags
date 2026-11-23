"""Offline scoreboard contract: persisted rows only, refreshed on writes."""

import asyncio
import importlib
from datetime import UTC, datetime

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, event, text

from app import scoreboard_projection
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
from app.scoreboard_projection import initialize_missing, refresh_affected
from tests.conftest import make_challenge, make_user, session_cookie
from tests.local_postgres import postgres_url  # noqa: F401
from tests.scoreboard_concurrency import (
    BONUS_AT,
    Workers,
    advisory_locks,
    assert_committed_totals,
    assert_recovery_holds_players_waiting_for_group,
    assert_writer_blocks_recovery,
    award_adjustment,
    cancel_workers,
    delete_confirmed_flag,
    failed_attempts,
    gold_solve,
    group_credits,
    remove_with_commit_hook,
    snapshot_records,
    wait_for_advisory_waiters,
    wait_for_no_advisory_locks,
)


@pytest.fixture
async def postgres_scoreboard(postgres_url):  # noqa: F811
    workers = Workers(postgres_url)
    try:
        yield workers
    finally:
        await workers.close()


@pytest.mark.parametrize("first", ["writer-first", "initializer-first", "group-first"])
async def test_postgres_initialization_overlapping_writes(postgres_scoreboard, first):
    """Two startup workers race with solves, failures, adjustments and group-only writes."""
    workers = postgres_scoreboard
    await workers.seed()
    operations = {
        "init-1": initialize_missing,
        "init-2": initialize_missing,
        "gold": gold_solve,
        "failed": failed_attempts,
        "adjust": award_adjustment,
        "groups": group_credits,
    }
    leader = {"writer-first": "adjust", "initializer-first": "init-1", "group-first": "groups"}[
        first
    ]
    ready, release = asyncio.Event(), asyncio.Event()
    tasks = []
    try:
        tasks.append(
            asyncio.create_task(
                workers.run(
                    leader,
                    operations.pop(leader),
                    ready=ready,
                    release=release,
                )
            )
        )
        async with asyncio.timeout(5):
            await ready.wait()
        if first == "group-first":
            # Establish the mixed-key lock chain before other writers start:
            # initializer holds player locks while waiting on the group writer.
            tasks.append(
                asyncio.create_task(
                    workers.run(
                        "init-1",
                        operations.pop("init-1"),
                    )
                )
            )
            async with workers.owner() as observer:
                await wait_for_advisory_waiters(observer, workers, ["init-1"], tasks)
        tasks.extend(
            asyncio.create_task(workers.run(name, operation))
            for name, operation in operations.items()
        )
        async with workers.owner() as observer:
            await wait_for_advisory_waiters(observer, workers, operations, tasks)
            # The leader has flushed projections but has not committed. Neither
            # its ledgers nor its projections may leak into another transaction.
            assert (
                await observer.execute(text("SELECT count(*) FROM player_scoreboard"))
            ).scalar_one() == 0
            assert (
                await observer.execute(text("SELECT count(*) FROM group_scoreboard"))
            ).scalar_one() == 0
        release.set()
        async with asyncio.timeout(12):
            await asyncio.gather(*tasks)
        assert len(set(workers.pids.values())) == 6
        await assert_committed_totals(workers, writes=True)
    finally:
        release.set()
        await cancel_workers(tasks)


async def test_postgres_simultaneous_initializers(postgres_scoreboard):
    """Overlapping startup workers fill a partial projection exactly once."""
    workers = postgres_scoreboard
    await workers.seed(partial=True)
    tasks = []
    try:
        async with workers.owner.begin() as blocker:
            await blocker.execute(text("SELECT pg_advisory_xact_lock(1180124755, 1)"))
            names = ["init-1", "init-2", "init-3"]
            tasks = [asyncio.create_task(workers.run(name, initialize_missing)) for name in names]
            await wait_for_advisory_waiters(blocker, workers, names, tasks)
        async with asyncio.timeout(12):
            results = await asyncio.gather(*tasks)
        assert results == [(1, 2)] * 3
        await assert_committed_totals(workers, writes=False)
    finally:
        await cancel_workers(tasks)


@pytest.mark.parametrize("partial", [False, True], ids=["empty", "partial"])
@pytest.mark.parametrize("first", ["writer-first", "initializer-first"])
async def test_postgres_initialization_overlapping_removals(
    postgres_scoreboard,
    settings,
    monkeypatch,
    first,
    partial,
):
    """An actual destructive transition races two recovery workers on real locks."""
    workers = postgres_scoreboard
    await workers.seed(partial=partial, removal=True)
    ready, release = asyncio.Event(), asyncio.Event()
    tasks = []

    async def remove(db):
        result = await delete_confirmed_flag(db, settings)
        assert result == {"deleted": True, "title": "Synthetic 1", "points": 40}

    if first == "writer-first":
        # Deletion commits inside its handler. Pause after real projection
        # refresh/flush but BEFORE that commit, not after the handler returns.
        original = flag_admin.refresh_affected

        async def hold_writer(db, users, groups):
            await original(db, users, groups)
            await db.flush()
            ready.set()
            await release.wait()

        monkeypatch.setattr(flag_admin, "refresh_affected", hold_writer)

    try:
        leader = "writer" if first == "writer-first" else "init-1"
        tasks.append(
            asyncio.create_task(
                workers.run(
                    leader,
                    remove if leader == "writer" else initialize_missing,
                    **({"ready": ready, "release": release} if leader == "init-1" else {}),
                )
            )
        )
        async with asyncio.timeout(5):
            await ready.wait()
        followers = {"init-2": initialize_missing}
        followers["init-1" if leader == "writer" else "writer"] = (
            initialize_missing if leader == "writer" else remove
        )
        tasks.extend(
            asyncio.create_task(workers.run(name, operation))
            for name, operation in followers.items()
        )
        async with workers.owner() as observer:
            await wait_for_advisory_waiters(observer, workers, followers, tasks)
            # Destructive ledgers and new projections are still uncommitted.
            assert await observer.scalar(text("SELECT count(*) FROM solves")) == 3
            assert await observer.scalar(text("SELECT count(*) FROM submissions")) == 1
            assert await observer.scalar(text("SELECT count(*) FROM player_scoreboard")) == int(
                partial
            )
            assert await observer.scalar(text("SELECT count(*) FROM group_scoreboard")) == int(
                partial
            )
        release.set()
        async with asyncio.timeout(12):
            await asyncio.gather(*tasks)
        assert len(set(workers.pids.values())) == 3
        await assert_committed_totals(workers, removal=True)
    finally:
        release.set()
        await cancel_workers(tasks)


@pytest.mark.parametrize("partial", [False, True], ids=["empty", "partial"])
async def test_postgres_initialization_after_removal_rollback(
    postgres_scoreboard,
    settings,
    monkeypatch,
    partial,
):
    """Flushed removals and audit rows must roll back before waiting recovery runs."""
    await assert_removal_interruption(
        postgres_scoreboard,
        settings,
        monkeypatch,
        partial,
        cancel=False,
    )


@pytest.mark.parametrize("partial", [False, True], ids=["empty", "partial"])
async def test_postgres_initialization_after_removal_cancellation(
    postgres_scoreboard,
    settings,
    monkeypatch,
    partial,
):
    """Task cancellation must propagate and roll back before blocked recovery runs."""
    await assert_removal_interruption(
        postgres_scoreboard,
        settings,
        monkeypatch,
        partial,
        cancel=True,
    )


@pytest.mark.parametrize("partial", [False, True], ids=["empty", "partial"])
@pytest.mark.parametrize("cancelled", ["init-1", "init-2"])
async def test_postgres_waiting_initializer_cancellation(
    postgres_scoreboard,
    settings,
    monkeypatch,
    cancelled,
    partial,
):
    """Cancelling either real lock waiter leaves the removal and recovery intact."""
    workers = postgres_scoreboard
    await workers.seed(partial=partial, removal=True)
    sources = (
        User,
        Challenge,
        Solve,
        Submission,
        GroupChallengeCredit,
        AuditLog,
    )
    projections = (PlayerScoreboard, GroupScoreboard)
    async with workers.owner() as observer:
        before = await snapshot_records(observer, sources + projections)
    ready, release = asyncio.Event(), asyncio.Event()
    tasks = {}

    async def remove(db):
        async def before_commit():
            await db.flush()
            # The barrier follows the real ledger, projection and audit writes.
            assert await snapshot_records(db, sources) != {
                model.__tablename__: before[model.__tablename__] for model in sources
            }
            ready.set()
            await release.wait()

        await remove_with_commit_hook(db, settings, monkeypatch, before_commit)

    try:
        tasks["writer"] = asyncio.create_task(workers.run("writer", remove))
        async with asyncio.timeout(5):
            await ready.wait()
        names = ["init-1", "init-2"]
        survivor = next(name for name in names if name != cancelled)
        async with workers.owner() as observer:
            # Establish queue order from actual PostgreSQL contention, not sleeps.
            for name in names:
                tasks[name] = asyncio.create_task(workers.run(name, initialize_missing))
                await wait_for_advisory_waiters(observer, workers, [name], tasks.values())
            await assert_writer_blocks_recovery(observer, workers, names)
            held = await advisory_locks(observer, workers, ["writer"])
            assert held and all(row.granted for row in held)
            assert await snapshot_records(observer, sources + projections) == before

            assert tasks[cancelled].cancel()
            # Await only the cancelled worker: cancellation must propagate before
            # the writer releases its locks, not after a commit or lock timeout.
            async with asyncio.timeout(5):
                with pytest.raises(asyncio.CancelledError):
                    await tasks[cancelled]
            assert tasks[cancelled].cancelled(), "Recovery swallowed cancellation"
            await wait_for_no_advisory_locks(observer, workers, [cancelled])
            assert not release.is_set()
            await wait_for_advisory_waiters(
                observer,
                workers,
                [survivor],
                [tasks["writer"], tasks[survivor]],
            )
            await assert_writer_blocks_recovery(observer, workers, [survivor])
            assert await advisory_locks(observer, workers, ["writer"]) == held
            assert await snapshot_records(observer, sources + projections) == before

        release.set()
        async with asyncio.timeout(12):
            results = await asyncio.gather(tasks["writer"], tasks[survivor])
        assert results == [None, (3 - int(partial), 3 - int(partial))]
        assert len(set(workers.pids.values())) == 3
        async with workers.owner() as observer:
            await wait_for_no_advisory_locks(observer, workers, tasks)
        # Inspect committed ledgers and projections before any recovery retry can
        # conceal damage; the oracle also checks audits and subsequent idempotence.
        await assert_committed_totals(workers, removal=True)
    finally:
        release.set()
        await cancel_workers(tasks.values())


@pytest.mark.parametrize("partial", [False, True], ids=["empty", "partial"])
async def test_postgres_partially_locked_initializer_cancellation(
    postgres_scoreboard,
    partial,
):
    """Cancel recovery holding player keys while its group key is still blocked."""
    workers = postgres_scoreboard
    await workers.seed(partial=partial)
    models = (
        User,
        Challenge,
        Solve,
        Submission,
        GroupChallengeCredit,
        AuditLog,
        PlayerScoreboard,
        GroupScoreboard,
    )
    async with workers.owner() as observer:
        before = await snapshot_records(observer, models)
    ready, release = asyncio.Event(), asyncio.Event()
    tasks = {}
    try:
        # The real group-only writer flushes both source and projection updates,
        # then stays uncommitted throughout cancellation and player-writer progress.
        tasks["writer"] = asyncio.create_task(
            workers.run(
                "writer",
                group_credits,
                ready=ready,
                release=release,
            )
        )
        async with asyncio.timeout(5):
            await ready.wait()
        async with workers.owner() as observer:
            held = await advisory_locks(observer, workers, ["writer"])
            assert len(held) == 2
            assert all(row.granted and row.classid == 1180124756 for row in held)
            tasks["cancelled"] = asyncio.create_task(
                workers.run(
                    "cancelled",
                    initialize_missing,
                )
            )
            await wait_for_advisory_waiters(
                observer,
                workers,
                ["cancelled"],
                tasks.values(),
            )
            await assert_recovery_holds_players_waiting_for_group(
                observer,
                workers,
                "cancelled",
                partial=partial,
            )
            # Queue the player-only writer first so it must finish independently
            # of the group writer. A surviving recovery queues behind it.
            for name, operation in (
                ("player", failed_attempts),
                ("survivor", initialize_missing),
            ):
                tasks[name] = asyncio.create_task(workers.run(name, operation))
                await wait_for_advisory_waiters(
                    observer,
                    workers,
                    [name],
                    tasks.values(),
                )
            await assert_writer_blocks_recovery(
                observer,
                workers,
                ["player", "survivor"],
                writer="cancelled",
            )
            for name in ("player", "survivor"):
                waiting = await advisory_locks(observer, workers, [name])
                assert len(waiting) == 1
                assert (waiting[0].classid, waiting[0].objid, waiting[0].granted) == (
                    1180124755,
                    1,
                    False,
                )
            assert await snapshot_records(observer, models) == before

            assert tasks["cancelled"].cancel()
            async with asyncio.timeout(5):
                with pytest.raises(asyncio.CancelledError):
                    await tasks["cancelled"]
            assert tasks["cancelled"].cancelled(), "Recovery swallowed cancellation"
            await wait_for_no_advisory_locks(observer, workers, ["cancelled"])
            # Do NOT release the group barrier to allow this writer to finish.
            async with asyncio.timeout(5):
                assert await tasks["player"] is None
            assert not release.is_set() and not tasks["writer"].done()
            await wait_for_advisory_waiters(
                observer,
                workers,
                ["survivor"],
                [tasks["writer"], tasks["survivor"]],
            )
            await assert_recovery_holds_players_waiting_for_group(
                observer,
                workers,
                "survivor",
                partial=partial,
            )
            assert await advisory_locks(observer, workers, ["writer"]) == held
            await wait_for_no_advisory_locks(observer, workers, ["player", "cancelled"])
            # Only the player writer committed; no cancelled recovery or group
            # writer changes can leak into this independent observer.
            after_player = await snapshot_records(observer, models)
            for model in models:
                if model not in (Submission, PlayerScoreboard):
                    assert after_player[model.__tablename__] == before[model.__tablename__]
            assert len(after_player["submissions"]) == 3
            assert (
                await observer.execute(
                    text(
                        "SELECT user_id, score, solves, failed_attempts "
                        "FROM player_scoreboard ORDER BY user_id"
                    )
                )
            ).all() == [(1, 50, 2, 1), (2, 0, 0, 2)]

        release.set()
        async with asyncio.timeout(12):
            results = await asyncio.gather(tasks["writer"], tasks["survivor"])
        assert results == [None, (2 - int(partial), 2)]
        assert len(set(workers.pids.values())) == 4
        # Check the committed ledger oracle before any idempotent recovery retry.
        await assert_committed_totals(workers, group_player_writes=True)
        async with workers.owner() as observer:
            await wait_for_no_advisory_locks(observer, workers, tasks)
            assert (
                await observer.scalar(
                    text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'")
                )
                == 0
            )
    finally:
        release.set()
        await cancel_workers(tasks.values())


@pytest.mark.parametrize("partial", [False, True], ids=["empty", "partial"])
async def test_postgres_flushed_initializer_cancellation(postgres_scoreboard, partial):
    """Cancel after all recovery writes reach PostgreSQL, before transaction commit."""
    workers = postgres_scoreboard
    await workers.seed(partial=partial)
    if partial:
        # Preserve a committed row in BOTH projections, not just a player row.
        async with workers.owner.begin() as db:
            db.add(
                GroupScoreboard(
                    group_name="Security",
                    score=50,
                    solves=2,
                    last_solve_at=BONUS_AT,
                )
            )
    sources = (
        User,
        Challenge,
        Solve,
        Submission,
        GroupChallengeCredit,
        AuditLog,
    )
    projections = (PlayerScoreboard, GroupScoreboard)
    models = sources + projections
    async with workers.owner() as observer:
        before = await snapshot_records(observer, models)
    ready, release = asyncio.Event(), asyncio.Event()
    tasks = []
    expected_result = (2 - int(partial), 2 - int(partial))

    async def before_commit(db, result):
        assert result == expected_result
        # Workers.run flushed before this hook. Raw column reads prove all player
        # AND group writes reached the DB, rather than sitting in the ORM queue.
        flushed = await snapshot_records(db, models)
        for model in sources:
            assert flushed[model.__tablename__] == before[model.__tablename__]
        for model in projections:
            table = model.__tablename__
            assert len(flushed[table]) == 2
            assert flushed[table] != before[table]
            assert all(row in flushed[table] for row in before[table])
        assert (
            await db.execute(
                text(
                    "SELECT user_id, score, solves, last_solve_at, failed_attempts "
                    "FROM player_scoreboard ORDER BY user_id"
                )
            )
        ).all() == [(1, 50, 2, BONUS_AT, 0), (2, 0, 0, None, 1)]
        assert (
            await db.execute(
                text(
                    "SELECT group_name, score, solves, last_solve_at "
                    "FROM group_scoreboard ORDER BY group_name"
                )
            )
        ).all() == [("Ops", 10, 1, BONUS_AT), ("Security", 50, 2, BONUS_AT)]
        ready.set()
        await release.wait()
        raise AssertionError("Cancelled recovery must never leave the commit barrier")

    try:
        task = asyncio.create_task(
            workers.run(
                "cancelled",
                initialize_missing,
                before_commit=before_commit,
            )
        )
        tasks.append(task)
        async with asyncio.timeout(5):
            await ready.wait()
        async with workers.owner() as observer:
            assert (
                await observer.scalar(text("SELECT pg_backend_pid()")) != workers.pids["cancelled"]
            )
            expected_locks = {
                (1180124755, user_id, 2, "ExclusiveLock", True)
                for user_id in ([1] if partial else [1, 2])
            }
            for name in ["Ops"] if partial else ["Ops", "Security"]:
                key = await observer.scalar(
                    text("SELECT hashtext(:name)::bigint & 4294967295"), {"name": name}
                )
                expected_locks.add((1180124756, key, 2, "ExclusiveLock", True))
            assert {
                (row.classid, row.objid, row.objsubid, row.mode, row.granted)
                for row in await advisory_locks(observer, workers, ["cancelled"])
            } == expected_locks
            assert not task.done() and not release.is_set()
            assert await snapshot_records(observer, models) == before
            assert task.cancel()
            async with asyncio.timeout(5):
                with pytest.raises(asyncio.CancelledError):
                    await task
            assert task.cancelled(), "Recovery swallowed cancellation"
            assert not release.is_set()
            await wait_for_no_advisory_locks(observer, workers, ["cancelled"])

        # Fresh transaction, BEFORE retry can conceal any partially saved rows.
        async with workers.owner() as observer:
            assert await snapshot_records(observer, models) == before
        async with asyncio.timeout(5):
            assert await workers.run("retry", initialize_missing) == expected_result
        assert len(set(workers.pids.values())) == 2
        async with workers.owner() as observer:
            recovered = await snapshot_records(observer, models)
            for model in sources:
                assert recovered[model.__tablename__] == before[model.__tablename__]
            for model in projections:
                table = model.__tablename__
                assert all(row in recovered[table] for row in before[table])
        # Independent ledger totals first, then a no-op initialization. Compare
        # every persisted column as well, including timestamps on prior rows.
        await assert_committed_totals(workers)
        async with workers.owner() as observer:
            assert await snapshot_records(observer, models) == recovered
            await wait_for_no_advisory_locks(observer, workers, ["cancelled", "retry"])
            assert (
                await observer.scalar(
                    text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'")
                )
                == 0
            )
    finally:
        await cancel_workers(tasks)
        release.set()


async def test_schema_only_deployment_initializes_missing_historical_rows(
    database,
    session,
    settings,
):
    active = await make_user(session, username="historical")
    inactive = await make_user(session, username="inactive")
    inactive.is_active = False
    challenge = await make_challenge(session, settings, slug="historical-score")
    at = datetime(2026, 1, 1, tzinfo=UTC)
    session.add_all(
        [
            Solve(user_id=active.id, challenge_id=challenge.id, points_awarded=40, solved_at=at),
            Submission(
                user_id=active.id, challenge_id=challenge.id, correct=False, submitted_at=at
            ),
            GroupChallengeCredit(
                group_name="Security", challenge_id=challenge.id, points_awarded=40, awarded_at=at
            ),
            Submission(
                user_id=inactive.id, challenge_id=challenge.id, correct=False, submitted_at=at
            ),
        ]
    )
    await session.commit()
    # A partly populated projection must not overwrite good existing snapshots.
    session.add(PlayerScoreboard(user_id=inactive.id, score=0, solves=0, failed_attempts=1))
    await session.commit()
    assert await initialize_missing(session) == (1, 1)
    await session.commit()
    player = await session.get(PlayerScoreboard, active.id)
    group = await session.get(GroupScoreboard, "Security")
    assert (player.score, player.solves, player.failed_attempts) == (40, 1, 1)
    assert (group.score, group.solves) == (40, 1)
    assert await initialize_missing(session) == (0, 0)
    await session.commit()
    assert (await session.get(PlayerScoreboard, inactive.id)).failed_attempts == 1


async def test_startup_repairs_rows_that_disagree_with_ledgers(session, settings):
    """A removed award source leaves stale totals that only the ledgers can correct."""
    user = await make_user(session, username="stale")
    challenge = await make_challenge(session, settings, slug="stale-score")
    at = datetime(2026, 1, 1, tzinfo=UTC)
    session.add_all(
        [
            Solve(user_id=user.id, challenge_id=challenge.id, points_awarded=40, solved_at=at),
            GroupChallengeCredit(
                group_name="Security", challenge_id=challenge.id, points_awarded=40, awarded_at=at
            ),
            PlayerScoreboard(
                user_id=user.id, score=50, solves=2, failed_attempts=0, last_solve_at=at
            ),
            GroupScoreboard(group_name="Security", score=50, solves=2, last_solve_at=at),
            GroupScoreboard(group_name="Orphaned", score=10, solves=1, last_solve_at=at),
        ]
    )
    await session.commit()
    assert await initialize_missing(session) == (1, 2)
    await session.commit()
    player = await session.get(PlayerScoreboard, user.id)
    group = await session.get(GroupScoreboard, "Security")
    assert (player.score, player.solves) == (40, 1)
    assert (group.score, group.solves) == (40, 1)
    assert await session.get(GroupScoreboard, "Orphaned") is None
    assert await initialize_missing(session) == (0, 0)


async def test_missing_key_rechecks_ledger_after_writer_lock(
    session,
    settings,
    monkeypatch,
):
    """Discovery is not a snapshot: recompute after acquiring the writer's lock."""
    user = await make_user(session, username="late-award")
    challenge = await make_challenge(session, settings, slug="late-award")
    at = datetime(2026, 1, 1, tzinfo=UTC)
    session.add(Solve(user_id=user.id, challenge_id=challenge.id, points_awarded=40, solved_at=at))
    await session.commit()
    original = scoreboard_projection.refresh_affected

    async def writer_before_lock(db, users, groups):
        assert users == {user.id} and not groups
        # Simulates a committed write landing between missing-key discovery and
        # the per-key lock; the initializer must use the latest ledger totals.
        db.add(
            Submission(user_id=user.id, challenge_id=challenge.id, correct=False, submitted_at=at)
        )
        await original(db, users, groups)

    monkeypatch.setattr(scoreboard_projection, "refresh_affected", writer_before_lock)
    assert await initialize_missing(session) == (1, 0)
    await session.commit()
    row = await session.get(PlayerScoreboard, user.id)
    assert (row.score, row.solves, row.failed_attempts) == (40, 1, 1)
    await refresh_affected(session, {user.id}, set())
    await session.commit()
    assert (await session.get(PlayerScoreboard, user.id)).failed_attempts == 1


async def test_board_reads_projection_without_ledger(
    client,
    settings,
    session,
    monkeypatch,
):
    user = await make_user(session, username="safe-player", groups=["Security"])
    challenge = await make_challenge(session, settings, slug="score-projection", flag="answer")
    assert challenge.id
    headers = session_cookie(settings, user)
    sql_reads = []

    def capture(_conn, _cursor, statement, _params, _ctx, _many):
        sql_reads.append(statement.lower())

    engine = session.bind
    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        assert (
            await client.post(
                "/api/challenges/score-projection/submit",
                json={"flag": "wrong"},
                headers=headers,
            )
        ).status_code == 200
        assert (
            await client.post(
                "/api/challenges/score-projection/submit",
                json={"flag": "answer"},
                headers=headers,
            )
        ).status_code == 200
        sql_reads.clear()
        board = (await client.get("/api/leaderboard", headers=headers)).json()
        groups = (await client.get("/api/leaderboard/groups", headers=headers)).json()
        mine = (await client.get("/api/leaderboard/me", headers=headers)).json()
        assert [(e["username"], e["score"], e["solves"], e["failed_attempts"]) for e in board] == [
            ("safe-player", challenge.points, 1, 1)
        ]
        assert [(e["group_name"], e["score"]) for e in groups] == [
            ("Security", challenge.points),
        ]
        assert mine["entry"]["rank"] == 1 and mine["total_players"] == 1
        # The auth dependency may query users, but board endpoints never scan award ledgers.
        assert not any(
            f" {name} " in f" {statement} "
            for statement in sql_reads
            for name in ("solves", "submissions", "group_challenge_credits")
        )
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)


def test_initial_migration_creates_the_current_schema(monkeypatch):
    """A fresh database needs only the single initial revision."""
    revision = importlib.import_module("app.alembic.versions.0001_initial")
    assert revision.down_revision is None
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        context = MigrationContext.configure(conn)
        op = Operations(context)
        for name in ("create_table", "create_index", "drop_table", "drop_index", "f"):
            monkeypatch.setattr(revision.op, name, getattr(op, name))
        revision.upgrade()
        assert compare_metadata(context, Base.metadata) == []
        revision.downgrade()
        assert (
            conn.execute(
                text("SELECT count(*) FROM sqlite_master WHERE type = 'table'")
            ).scalar_one()
            == 0
        )


async def assert_removal_interruption(
    workers,
    settings,
    monkeypatch,
    partial,
    *,
    cancel,
):
    await workers.seed(partial=partial, removal=True)
    if partial:
        # A nonzero player is changed by the removal. The seeded group loses
        # its final award and is deleted, so rollback must restore that row too.
        async with workers.owner.begin() as db:
            db.add(
                PlayerScoreboard(
                    user_id=1,
                    score=50,
                    solves=2,
                    failed_attempts=0,
                    last_solve_at=BONUS_AT,
                )
            )
    sources = (
        User,
        Challenge,
        Solve,
        Submission,
        GroupChallengeCredit,
        AuditLog,
    )
    projections = (PlayerScoreboard, GroupScoreboard)
    async with workers.owner() as observer:
        before = await snapshot_records(observer, sources)
        prior_scores = await snapshot_records(observer, projections)

    class InjectedRemovalFailure(RuntimeError):
        pass

    ready, release = asyncio.Event(), asyncio.Event()
    tasks = []

    async def remove(db):
        async def interrupt_before_commit():
            # Flush the real audit row too; failing at refresh_affected would
            # occur before deletion has even constructed its audit event.
            await db.flush()
            changed = await snapshot_records(db, sources)
            scores = await snapshot_records(db, projections)
            player = next(row for row in scores["player_scoreboard"] if row["user_id"] == 1)
            assert player["score"] == 10
            assert "GoldOnly" not in {row["group_name"] for row in scores["group_scoreboard"]}
            assert {row["id"] for row in changed["challenges"]} == {2, 3, 4}
            assert changed["submissions"] == []
            for table in ("solves", "group_challenge_credits"):
                assert {row["challenge_id"] for row in changed[table]} == {4}
            (audit,) = changed["audit_log"]
            assert audit["event_type"] == "flag_admin_challenge_deleted"
            assert audit["detail"] == {"challenge": "synthetic-1", "points": 40}
            assert all(
                row["score"] == row["solves"] == row["failed_attempts"] == 0
                for row in scores["player_scoreboard"]
                if row["user_id"] in {2, 3}
            )
            ready.set()
            await release.wait()
            # A cancellation case must exit through Task.cancel(), not this
            # ordinary exception (nor a manually raised CancelledError).
            assert not cancel, "Cancelled writer resumed past the flush barrier"
            raise InjectedRemovalFailure("injected before removal commit")

        await remove_with_commit_hook(db, settings, monkeypatch, interrupt_before_commit)

    try:
        tasks.append(asyncio.create_task(workers.run("writer", remove)))
        async with asyncio.timeout(5):
            await ready.wait()
        names = ["init-1", "init-2"]
        tasks.extend(asyncio.create_task(workers.run(name, initialize_missing)) for name in names)
        async with workers.owner() as observer:
            await wait_for_advisory_waiters(observer, workers, names, tasks)
            blockers = set(
                (
                    await observer.scalars(
                        text(
                            "SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity "
                            "WHERE pid IN (:first, :second)"
                        ),
                        {"first": workers.pids[names[0]], "second": workers.pids[names[1]]},
                    )
                ).all()
            )
            assert workers.pids["writer"] in blockers
            assert await snapshot_records(observer, sources) == before
            assert await snapshot_records(observer, projections) == prior_scores
        if cancel:
            assert tasks[0].cancel()
        else:
            release.set()
        async with asyncio.timeout(12):
            results = await asyncio.gather(*tasks, return_exceptions=True)
        if cancel:
            assert type(results[0]) is asyncio.CancelledError, results
            assert tasks[0].cancelled(), "Writer swallowed cancellation"
        else:
            assert type(results[0]) is InjectedRemovalFailure, results
            assert str(results[0]) == "injected before removal commit"
        assert results[1:] == [(3 - 2 * int(partial), 3 - int(partial))] * 2
        assert len(set(workers.pids.values())) == 3
        async with workers.owner() as observer:
            assert await snapshot_records(observer, sources) == before
            restored_scores = await snapshot_records(observer, projections)
            for table, rows in prior_scores.items():
                assert all(row in restored_scores[table] for row in rows)
            assert (
                await observer.scalar(
                    text(
                        "SELECT count(*) FROM pg_locks "
                        "WHERE locktype = 'advisory' AND pid IN (:writer, :first, :second)"
                    ),
                    {
                        "writer": workers.pids["writer"],
                        "first": workers.pids[names[0]],
                        "second": workers.pids[names[1]],
                    },
                )
                == 0
            )
        await assert_committed_totals(workers, removal=True, rolled_back=True)
    finally:
        release.set()
        await cancel_workers(tasks)
