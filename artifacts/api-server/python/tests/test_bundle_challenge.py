from sqlalchemy import select

from app.bundle_challenge import FLAG, PUZZLE_VALUE, SLUG, TITLE, DESCRIPTION, POINTS
from app.models import Challenge
from app.terminal_challenges import prepare_terminal_challenges, terminal_status
from tests.conftest import make_user, session_cookie
from tests.conftest import make_challenge


async def test_existing_bundle_category_normalizes_without_changing_points(session, settings):
    from app.crack_hashes import normalize_hash_categories
    row = await make_challenge(session, settings, slug=SLUG, flag=FLAG,
                               points=POINTS, category="gold")
    row.title, row.description = TITLE, DESCRIPTION
    await session.commit()
    original_id, original_hash = row.id, row.flag_hash
    assert await normalize_hash_categories(session) == 1
    await session.refresh(row)
    assert (row.id, row.flag_hash, row.points, row.category) == (
        original_id, original_hash, POINTS, "OWASP",
    )
    assert await normalize_hash_categories(session) == 0
    assert not next(item for item in await terminal_status(session, settings) if item["slug"] == SLUG)["missing"]


async def test_discovery_simulation_and_scoring(client, settings, session):
    user = await make_user(session, username="puzzle-player")
    headers = session_cookie(settings, user)
    path = "/api/cli/promote_user_to_admin"
    assert (await client.get("/api/cli/commands")).status_code == 401
    assert (await client.post(path, json={"token": PUZZLE_VALUE})).status_code == 401
    discovery = await client.get("/api/cli/commands", headers=headers)
    assert {"submit", "scoreboard", "promote_user_to_admin"} <= set(discovery.json()["commands"])
    assert FLAG not in discovery.text and PUZZLE_VALUE not in discovery.text
    for value in ("wrong", "λ", PUZZLE_VALUE + " "):
        assert (await client.post(path, headers=headers, json={"token": value})).status_code == 403
    assert (await client.post(path, headers=headers, json={})).status_code == 422
    result = await client.post(path, headers=headers, json={"token": PUZZLE_VALUE})
    assert result.status_code == 200 and result.json()["flag"] == FLAG
    await session.refresh(user)
    assert not user.is_admin and user.groups == []
    assert (await client.get("/api/flag-admin/import-challenges", headers=headers)).status_code == 403
    assert "/api/cli/commands" not in (await client.get("/api/openapi.json")).json()["paths"]

    missing = {item["slug"] for item in await terminal_status(session, settings) if item["missing"]}
    session.add_all(await prepare_terminal_challenges(session, settings, missing))
    await session.commit()
    row = await session.scalar(select(Challenge).where(Challenge.slug == SLUG))
    assert (row.title, row.description, row.category, row.points) == (TITLE, DESCRIPTION, "OWASP", POINTS)
    assert not any(item["missing"] for item in await terminal_status(session, settings))
    solved = await client.post("/api/challenges/submit", headers=headers, json={"flag": FLAG})
    assert solved.json()["correct"] and solved.json()["points_awarded"] == POINTS
    repeat = await client.post("/api/challenges/submit", headers=headers, json={"flag": FLAG})
    assert repeat.json()["points_awarded"] == 0
