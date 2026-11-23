"""Data migration cannot change unrelated Gold rows or earned scores."""


import pytest
from sqlalchemy import event, select

from app.crack_hashes import PUZZLES, normalize_hash_categories, puzzle_description
from app.main import create_app
from app.models import Challenge, Solve
from tests.conftest import make_challenge, make_user


async def test_talks_category_preserves_flags_scores_and_customized_records(settings, database):
    async with database.session_factory() as session:
        owner = await make_user(session)
        rows = []
        for day in ("02", "09", "16"):
            row = await make_challenge(
                session, settings, slug=f"talk-demo-day-2026-10-{day}",
                flag=f"synthetic-talk-{day}", category="gold", points=500,
            )
            row.title = f"Talk: Demo Day 10/{day}"
            row.description = f"Gave a security related talk on Weekly Demos 10/{day}/2026"
            rows.append(row)
        other = await make_challenge(session, settings, slug="unrelated-talk",
                                     flag="synthetic-other", category="gold", points=500)
        other.title, other.description = rows[0].title, rows[0].description
        session.add(Solve(user_id=owner.id, challenge_id=rows[0].id, points_awarded=500))
        await session.commit()
        ids = [row.id for row in rows]
        hashes = [row.flag_hash for row in rows]
        assert await normalize_hash_categories(session) == 3
        assert await normalize_hash_categories(session) == 0
        for row in rows:
            await session.refresh(row)
        assert [row.category for row in rows] == ["Talks"] * 3
        assert [row.flag_hash for row in rows] == hashes
        assert [row.points for row in rows] == [500] * 3
        await session.refresh(other)
        assert other.category == "gold"
        award = (await session.execute(select(Solve).where(Solve.challenge_id == ids[0]))).scalar_one()
        assert award.points_awarded == 500
        # An administrator's later categorization is not overwritten on restart.
        rows[0].category = "Custom"
        rows[1].category = "gold"
        rows[1].description += " customized"
        await session.commit()
        assert await normalize_hash_categories(session) == 0


async def test_startup_normalizes_exact_legacy_rows_in_one_transaction_and_is_idempotent(
    settings, database,
):
    async with database.session_factory() as session:
        owner = await make_user(session)
        puzzle_ids = []
        for slug, title, points, algorithm, digest, hint in PUZZLES:
            row = await make_challenge(
                session, settings, slug=slug, flag=f"secret-{slug}", category="gold",
                points=points,
            )
            row.title = title
            row.description = puzzle_description(algorithm, digest, hint)
            puzzle_ids.append(row.id)
        session.add(Solve(user_id=owner.id, challenge_id=puzzle_ids[0], points_awarded=50))
        untouched_ids = []
        for suffix in ("different-slug", "different-description", "case-sensitive", "hidden"):
            slug, title, points, algorithm, digest, hint = PUZZLES[0]
            row = await make_challenge(
                session, settings, slug=f"{slug}-{suffix}", flag=f"secret-{suffix}",
                category="gold", points=points,
            )
            row.title = title
            row.description = puzzle_description(algorithm, digest, hint)
            if suffix == "different-description":
                row.description += " modified"
            if suffix == "case-sensitive":
                row.case_sensitive = True
            if suffix == "hidden":
                row.hidden = True
            untouched_ids.append(row.id)
        await session.commit()

    app = create_app(settings, database=database)
    updates = []

    def record_update(_conn, _cursor, statement, _params, _context, _executemany):
        if statement.lstrip().upper().startswith("UPDATE CHALLENGES"):
            updates.append(statement)

    event.listen(database.engine.sync_engine, "before_cursor_execute", record_update)
    async with app.router.lifespan_context(app):
        assert len(updates) == 1  # All three category edits in one DB statement/commit.
        async with database.session_factory() as session:
            rows = (await session.execute(select(Challenge).order_by(Challenge.id))).scalars().all()
            assert {row.id for row in rows if row.category == "cracking"} == set(puzzle_ids)
            assert {row.id for row in rows if row.category == "gold"} == set(untouched_ids)
            assert await session.scalar(select(Solve.points_awarded)) == 50
        # A second startup transaction cannot recategorize or disturb migrated rows.
        async with database.session_factory() as session:
            assert await normalize_hash_categories(session) == 0
            assert {row.id for row in (
                await session.execute(select(Challenge).where(Challenge.category == "cracking"))
            ).scalars().all()} == set(puzzle_ids)
    event.remove(database.engine.sync_engine, "before_cursor_execute", record_update)


@pytest.mark.parametrize(
    "mismatch",
    ("description", "title", "points", "case_sensitive", "hidden", "is_active"),
)
async def test_startup_leaves_mismatched_fingerprint_untouched(settings, database, mismatch):
    async with database.session_factory() as session:
        slug, title, points, algorithm, digest, hint = PUZZLES[0]
        row = await make_challenge(
            session, settings, slug=slug, flag="a-different-answer",
            category="gold", points=points,
        )
        row.title = title
        row.description = puzzle_description(algorithm, digest, hint)
        if mismatch == "description":
            row.description += " changed"
        elif mismatch == "title":
            row.title += " changed"
        elif mismatch == "points":
            row.points += 1
        elif mismatch == "case_sensitive":
            row.case_sensitive = True
        elif mismatch == "hidden":
            row.hidden = True
        elif mismatch == "is_active":
            row.is_active = False
        original_id = row.id
        await session.commit()
    app = create_app(settings, database=database)
    async with app.router.lifespan_context(app):
        async with database.session_factory() as session:
            row = await session.get(Challenge, original_id)
            assert row is not None
            assert row.category == "gold"