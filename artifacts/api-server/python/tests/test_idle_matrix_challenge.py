from unittest.mock import AsyncMock

import pytest
from sqlalchemy import event

from app.models import Solve
from app.routers import challenges
from app.terminal_challenges import (
    IDLE_MATRIX_PUZZLE,
    metadata,
    prepare_terminal_challenges,
    terminal_status,
)
from tests.conftest import make_challenge, make_user, session_cookie

STATUS_URL = "/api/challenges/matrix/status"


async def test_idle_matrix_catalog_and_one_time_award(client, settings, session):
    assert metadata(IDLE_MATRIX_PUZZLE[0]) == ("OWASP", 25)
    status = await terminal_status(session, settings)
    session.add_all(
        await prepare_terminal_challenges(
            session,
            settings,
            {p["slug"] for p in status if p["missing"]},
        )
    )
    await session.commit()
    user = await make_user(session, username="idle-matrix-player")
    headers = session_cookie(settings, user)
    assert (await client.get(STATUS_URL, headers=headers)).json() == {"solved": False}
    listing = await client.get("/api/challenges?category=OWASP", headers=headers)
    assert listing.status_code == 200
    assert "Enter the Matrix" in listing.text
    assert IDLE_MATRIX_PUZZLE[2] in listing.text
    assert IDLE_MATRIX_PUZZLE[3] not in listing.text
    for points in (25, 0):
        result = await client.post(
            "/api/challenges/submit",
            headers=headers,
            json={"flag": IDLE_MATRIX_PUZZLE[3]},
        )
        assert result.status_code == 200
        assert result.json()["correct"] is True
        assert result.json()["points_awarded"] == points
        assert (await client.get(STATUS_URL, headers=headers)).json() == {"solved": True}


async def test_matrix_status_is_private_and_does_not_load_catalog_or_refresh(
    client,
    settings,
    session,
    database,
    monkeypatch,
):
    alice = await make_user(session, username="matrix-owner")
    bob = await make_user(session, username="matrix-other", is_admin=True)
    challenge = await make_challenge(session, settings, slug="enter-the-matrix")
    unrelated = await make_challenge(session, settings, slug="unrelated")
    session.add_all(
        [
            Solve(user_id=alice.id, challenge_id=challenge.id, points_awarded=25),
            Solve(user_id=bob.id, challenge_id=unrelated.id, points_awarded=100),
        ]
    )
    await session.commit()
    forbidden = AsyncMock(side_effect=AssertionError("Matrix must not read the catalog"))
    monkeypatch.setattr(challenges, "_solved_ids", forbidden)
    monkeypatch.setattr(challenges, "_solve_counts", forbidden)
    queries = []

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        queries.append(statement)

    event.listen(database.engine.sync_engine, "before_cursor_execute", capture)
    try:
        for user, expected in ((alice, True), (bob, False), (alice, True)):
            queries.clear()
            # Caller-supplied identities cannot select another player's status.
            response = await client.get(
                f"{STATUS_URL}?user_id={alice.id}&account_id={alice.id}",
                headers=session_cookie(settings, user),
            )
            assert response.status_code == 200
            assert response.json() == {"solved": expected}
            assert response.headers["cache-control"] == "no-store"
            solve_queries = [sql for sql in queries if "solves" in sql]
            assert len(solve_queries) == 1
            assert "EXISTS" in solve_queries[0]
            assert "solves.user_id =" in solve_queries[0]
            assert "count(" not in solve_queries[0].lower()
            assert len(queries) == 2  # Authentication plus one existence lookup.
    finally:
        event.remove(database.engine.sync_engine, "before_cursor_execute", capture)
    forbidden.assert_not_awaited()


@pytest.mark.parametrize("identity", ["anonymous", "invalid", "disabled"])
async def test_matrix_status_requires_active_authenticated_user(
    client,
    settings,
    session,
    identity,
):
    headers = {}
    if identity == "invalid":
        headers = {"Cookie": f"{settings.session_cookie_name}=not-a-session"}
    elif identity == "disabled":
        user = await make_user(session)
        user.is_active = False
        await session.commit()
        headers = session_cookie(settings, user)
    response = await client.get(STATUS_URL, headers=headers)
    assert response.status_code == 401
    assert "solved" not in response.json()


async def test_matrix_status_missing_inactive_and_deleted_challenge(client, settings, session):
    user = await make_user(session)
    headers = session_cookie(settings, user)
    assert (await client.get(STATUS_URL, headers=headers)).json() == {"solved": False}
    challenge = await make_challenge(session, settings, slug="enter-the-matrix", is_active=False)
    session.add(Solve(user_id=user.id, challenge_id=challenge.id, points_awarded=25))
    await session.commit()
    assert (await client.get(STATUS_URL, headers=headers)).json() == {"solved": False}
    challenge.is_active = True
    await session.commit()
    assert (await client.get(STATUS_URL, headers=headers)).json() == {"solved": True}
    await session.delete(challenge)
    await session.commit()
    assert (await client.get(STATUS_URL, headers=headers)).json() == {"solved": False}
