from __future__ import annotations

from sqlalchemy import select

from app.models import Solve, Submission
from app.seed import SeedFile, load_seed_file, upsert_challenges
from tests.conftest import make_challenge, make_user, session_cookie


async def test_health_and_ready(client):
    assert (await client.get("/api/health")).json() == {"status": "ok"}
    assert (await client.get("/api/ready")).json() == {"status": "ready"}


async def test_challenges_are_public_but_submit_is_not(client, settings, session):
    await make_challenge(session, settings, slug="open", flag="x")
    listing = await client.get("/api/challenges")
    assert listing.status_code == 200
    assert listing.json()[0]["slug"] == "open"
    assert listing.json()[0]["solved"] is False
    assert (await client.get("/api/challenges/open")).status_code == 200
    assert (await client.post("/api/challenges/open/submit", json={"flag": "x"})).status_code == 401


async def test_list_and_submit_flow(client, settings, session):
    user = await make_user(session)
    await make_challenge(session, settings, slug="warmup", flag="semgrep{Hi}", points=100)
    await make_challenge(session, settings, slug="hidden", flag="x", is_active=False)
    headers = session_cookie(settings, user)

    listing = await client.get("/api/challenges", headers=headers)
    assert listing.status_code == 200
    assert [c["slug"] for c in listing.json()] == ["warmup"]
    assert listing.json()[0]["solved"] is False

    wrong = await client.post(
        "/api/challenges/warmup/submit", json={"flag": "nope"}, headers=headers
    )
    assert wrong.status_code == 200
    assert wrong.json()["correct"] is False
    assert wrong.json()["total_score"] == 0

    # case-insensitive by default, whitespace tolerant
    right = await client.post(
        "/api/challenges/warmup/submit", json={"flag": "  SEMGREP{hi} "}, headers=headers
    )
    assert right.json() == {
        "correct": True,
        "already_solved": False,
        "points_awarded": 100,
        "total_score": 100,
        "message": "Nice work! +100 points.",
    }

    again = await client.post(
        "/api/challenges/warmup/submit", json={"flag": "semgrep{Hi}"}, headers=headers
    )
    assert again.json()["already_solved"] is True
    assert again.json()["points_awarded"] == 0
    assert again.json()["total_score"] == 100

    detail = await client.get("/api/challenges/warmup", headers=headers)
    assert detail.json()["solved"] is True
    assert detail.json()["solve_count"] == 1

    assert (await client.get("/api/challenges/hidden", headers=headers)).status_code == 404

    me = await client.get("/api/auth/me", headers=headers)
    assert me.json()["score"] == 100
    assert me.json()["solves"] == 1

    assert len((await session.execute(select(Submission))).scalars().all()) == 3
    assert len((await session.execute(select(Solve))).scalars().all()) == 1


async def test_case_sensitive_flag(client, settings, session):
    user = await make_user(session)
    await make_challenge(session, settings, slug="cs", flag="semgrep{CaSe}", case_sensitive=True)
    headers = session_cookie(settings, user)
    assert (
        await client.post(
            "/api/challenges/cs/submit", json={"flag": "semgrep{case}"}, headers=headers
        )
    ).json()["correct"] is False
    assert (
        await client.post(
            "/api/challenges/cs/submit", json={"flag": "semgrep{CaSe}"}, headers=headers
        )
    ).json()["correct"] is True


async def test_rate_limit(client, settings, session):
    user = await make_user(session)
    await make_challenge(session, settings, slug="rl", flag="x")
    headers = session_cookie(settings, user)
    for _ in range(5):
        assert (
            await client.post("/api/challenges/rl/submit", json={"flag": "no"}, headers=headers)
        ).status_code == 200
    assert (
        await client.post("/api/challenges/rl/submit", json={"flag": "no"}, headers=headers)
    ).status_code == 429


async def test_leaderboard(client, settings, session):
    a = await make_user(session, username="alice")
    b = await make_user(session, username="bob")
    await make_challenge(session, settings, slug="c1", flag="f1", points=100)
    await make_challenge(session, settings, slug="c2", flag="f2", points=250)
    await client.post(
        "/api/challenges/c1/submit", json={"flag": "f1"}, headers=session_cookie(settings, a)
    )
    await client.post(
        "/api/challenges/c2/submit", json={"flag": "f2"}, headers=session_cookie(settings, b)
    )
    await client.post(
        "/api/challenges/c1/submit", json={"flag": "f1"}, headers=session_cookie(settings, b)
    )

    board = (await client.get("/api/leaderboard")).json()
    assert [(e["rank"], e["username"], e["score"], e["solves"]) for e in board] == [
        (1, "bob", 350, 2),
        (2, "alice", 100, 1),
    ]
    # limit only trims the list; ranks stay absolute
    top1 = (await client.get("/api/leaderboard?limit=1")).json()
    assert [e["username"] for e in top1] == ["bob"]

    mine = (await client.get("/api/leaderboard/me", headers=session_cookie(settings, a))).json()
    assert mine == {
        "entry": {
            "rank": 2,
            "username": "alice",
            "full_name": "Alice",
            "score": 100,
            "solves": 1,
            "last_solve_at": mine["entry"]["last_solve_at"],
        },
        "total_players": 2,
    }
    carol = await make_user(session, username="carol")
    unranked = (
        await client.get("/api/leaderboard/me", headers=session_cookie(settings, carol))
    ).json()
    assert unranked["entry"]["rank"] is None
    assert unranked["entry"]["score"] == 0
    assert unranked["total_players"] == 2
    assert (await client.get("/api/leaderboard/me")).status_code == 401


async def test_admin_gating_and_upsert(client, settings, session):
    player = await make_user(session, username="player")
    admin = await make_user(session, username="admin", is_admin=True, groups=["ctf-admins"])

    assert (
        await client.get("/api/admin/challenges", headers=session_cookie(settings, player))
    ).status_code == 403

    body = {"title": "New", "category": "web", "points": 300, "flag": "semgrep{new}"}
    created = await client.put(
        "/api/admin/challenges/new-one", json=body, headers=session_cookie(settings, admin)
    )
    assert created.status_code == 200
    assert created.json()["slug"] == "new-one"
    assert "flag" not in created.json() and "flag_hash" not in created.json()

    # update without a flag keeps the old one
    body2 = {"title": "Renamed", "points": 350}
    updated = await client.put(
        "/api/admin/challenges/new-one", json=body2, headers=session_cookie(settings, admin)
    )
    assert updated.json()["title"] == "Renamed"
    ok = await client.post(
        "/api/challenges/new-one/submit",
        json={"flag": "semgrep{new}"},
        headers=session_cookie(settings, player),
    )
    assert ok.json()["correct"] is True
    assert ok.json()["points_awarded"] == 350

    users = (await client.get("/api/admin/users", headers=session_cookie(settings, admin))).json()
    assert {u["username"]: u["score"] for u in users} == {"player": 350, "admin": 0}
    audit = (await client.get("/api/admin/audit", headers=session_cookie(settings, admin))).json()
    assert {a["event_type"] for a in audit} >= {
        "admin_challenge_created",
        "admin_challenge_updated",
        "flag_correct",
    }
    subs = (
        await client.get("/api/admin/submissions", headers=session_cookie(settings, admin))
    ).json()
    assert subs[0]["challenge_slug"] == "new-one" and subs[0]["correct"] is True

    assert (
        await client.put(
            "/api/admin/challenges/Bad Slug", json=body, headers=session_cookie(settings, admin)
        )
    ).status_code == 422
    assert (
        await client.delete(
            "/api/admin/challenges/new-one", headers=session_cookie(settings, admin)
        )
    ).status_code == 204
    assert (
        await client.get("/api/challenges/new-one", headers=session_cookie(settings, player))
    ).status_code == 404


async def test_seed_upsert(settings, session, tmp_path):
    seed = SeedFile.model_validate(
        {
            "challenges": [
                {"slug": "a", "title": "A", "flag": "fa", "points": 10},
                {"slug": "b", "title": "B", "flag_hash": "0" * 64, "points": 20},
            ]
        }
    )
    assert await upsert_challenges(session, settings, seed) == {"created": 2, "updated": 0}
    seed2 = SeedFile.model_validate({"challenges": [{"slug": "a", "title": "A2", "points": 15}]})
    assert await upsert_challenges(session, settings, seed2) == {"created": 0, "updated": 1}

    path = tmp_path / "c.yaml"
    path.write_text("challenges:\n  - slug: Bad_Slug\n    title: x\n    flag: y\n")
    try:
        load_seed_file(path)
    except ValueError as exc:
        assert "slug" in str(exc)
    else:
        raise AssertionError("expected validation error")
