"""Opt-in concurrency checks against a fresh Unix-socket-only PostgreSQL cluster."""

import asyncio
import hashlib
import os
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import func, select

from app import crack_hashes
from app.db import Base, Database
from app.main import create_app
from app.models import Challenge, GroupChallengeCredit, Solve, Submission
from tests.conftest import make_challenge, make_user, session_cookie

pytestmark = pytest.mark.skipif(
    os.environ.get("GROUP_SCORING_TEST_POSTGRES") != "1",
    reason="disposable local PostgreSQL opt-in required",
)


@pytest.fixture
async def postgres_client(settings):
    target = os.environ.get("GROUP_SCORING_TEST_POSTGRES_URL")
    if not target:
        pytest.fail("A disposable PostgreSQL target is required")
    parsed = urlsplit(target)
    socket_dir = parse_qs(parsed.query).get("host", [""])[0]
    if parsed.hostname is not None or not socket_dir.startswith("/tmp/"):
        pytest.fail("Concurrency tests require a private PostgreSQL Unix socket under /tmp")

    db = Database(settings, url=target)
    try:
        async with db.engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)
            await connection.run_sync(Base.metadata.create_all)
        app = create_app(settings, database=db)
        async with (
            httpx.ASGITransport(app=app) as transport,
            httpx.AsyncClient(transport=transport, base_url="http://ui.test") as client,
            app.router.lifespan_context(app),
        ):
            yield db, client
    finally:
        await db.dispose()


async def test_concurrent_same_user_awards_once(postgres_client, settings):
    db, client = postgres_client
    async with db.session_factory() as session:
        user = await make_user(session, groups=["Shared"])
        await make_challenge(session, settings, slug="same-user", flag="correct")
        headers = session_cookie(settings, user)

    responses = await asyncio.gather(
        client.post("/api/challenges/same-user/submit", json={"flag": "correct"}, headers=headers),
        client.post("/api/challenges/same-user/submit", json={"flag": "correct"}, headers=headers),
    )
    payloads = [response.json() for response in responses]
    assert sorted(payload["points_awarded"] for payload in payloads) == [0, 100]
    assert sorted(payload["already_solved"] for payload in payloads) == [False, True]

    async with db.session_factory() as session:
        assert await session.scalar(select(func.count(Solve.id))) == 1
        assert await session.scalar(select(func.count(GroupChallengeCredit.id))) == 1
        assert await session.scalar(select(func.count(Submission.id))) == 2


async def test_concurrent_hash_import_does_not_overwrite_or_duplicate(
    postgres_client, settings, monkeypatch,
):
    db, client = postgres_client
    words = {name: f"offline-race-{name}" for name in ("easy", "medium", "hard")}
    monkeypatch.setattr(crack_hashes, "PUZZLES", tuple(
        (f"crack-the-hash-{name}", f"Crack The Hash: {name.title()}", points,
         "MD5", hashlib.md5(words[name].encode()).hexdigest(), "")
        for name, points in (("easy", 50), ("medium", 150), ("hard", 400))
    ))
    async with db.session_factory() as session:
        operator = await make_user(
            session, username="hash-operator", groups=["funwithflags-admins"]
        )
        operator.okta_sub = "saml:" + "a" * 64
        operator.last_login_at = datetime.now(UTC)
        await session.commit()
        headers = session_cookie(settings, operator)
    terminal_missing = [
        row["slug"] for row in (await client.get(
            "/api/flag-admin/import-challenges", headers=headers
        )).json()["terminal"]
    ]
    responses = await asyncio.gather(*(
        client.post(
            "/api/flag-admin/import-challenges",
            json={**words, "terminal_missing": terminal_missing}, headers=headers,
        )
        for _ in range(2)
    ))
    assert sorted(response.status_code for response in responses) == [200, 409]
    async with db.session_factory() as session:
        assert await session.scalar(select(func.count(Challenge.id))) == 3 + len(terminal_missing)


async def test_concurrent_users_credit_shared_group_once(postgres_client, settings):
    db, client = postgres_client
    async with db.session_factory() as session:
        alice = await make_user(session, username="alice", groups=["Shared", "Alpha"])
        bob = await make_user(session, username="bob", groups=["Shared", "Bravo"])
        await make_challenge(session, settings, slug="shared-group", flag="correct", points=250)
        alice_headers = session_cookie(settings, alice)
        bob_headers = session_cookie(settings, bob)

    responses = await asyncio.gather(
        client.post(
            "/api/challenges/shared-group/submit",
            json={"flag": "correct"},
            headers=alice_headers,
        ),
        client.post(
            "/api/challenges/shared-group/submit",
            json={"flag": "correct"},
            headers=bob_headers,
        ),
    )
    assert [response.json()["points_awarded"] for response in responses] == [250, 250]

    async with db.session_factory() as session:
        assert await session.scalar(select(func.count(Solve.id))) == 2
        credits = (await session.execute(select(GroupChallengeCredit))).scalars().all()
        assert sorted(credit.group_name for credit in credits) == ["Alpha", "Bravo", "Shared"]
        assert all(credit.points_awarded == 250 for credit in credits)