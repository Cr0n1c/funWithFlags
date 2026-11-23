from __future__ import annotations

import time
from datetime import UTC, datetime

import jwt
from sqlalchemy import select

from app.models import (
    AuditLog,
    GroupChallengeCredit,
    Solve,
    Submission,
)
from app.security import SESSION_AUDIENCE
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
    assert (await client.get("/api/challenges/notifications")).status_code == 401


async def test_mail_feed_bootstrap_pagination_and_account_isolation(client, settings, session):
    alice = await make_user(session, username="mail-alice")
    bob = await make_user(session, username="mail-bob")
    await make_challenge(session, settings, slug="mail-check", flag="secret-flag")
    ah = session_cookie(settings, alice)
    bh = session_cookie(settings, bob)
    old = await client.post("/api/challenges/submit", json={"flag": "bad"}, headers=ah)
    bootstrap = (await client.get(
        "/api/challenges/notifications?initialize=true", headers=ah
    )).json()
    assert bootstrap["gold"] == []
    assert bootstrap["gold_cursor"] == old.json()["event_id"]
    assert (await client.get(
        "/api/challenges/notifications", headers=bh
    )).json()["gold"] == []
    wrong = await client.post("/api/challenges/submit", json={"flag": "bad2"}, headers=ah)
    correct = await client.post(
        "/api/challenges/submit", json={"flag": "secret-flag"}, headers=ah
    )
    page = (await client.get(
        "/api/challenges/notifications",
        params={"gold_after": bootstrap["gold_cursor"], "limit": 1}, headers=ah,
    )).json()
    assert page["gold_more"] is True
    assert page["gold"][0]["id"] == wrong.json()["event_id"]
    following = (await client.get(
        "/api/challenges/notifications",
        params={"gold_after": page["gold_cursor"], "limit": 1}, headers=ah,
    )).json()
    assert following["gold_more"] is False
    assert following["gold"][0]["id"] == correct.json()["event_id"]
    assert following["gold"][0]["outcome"] == "correct"
    assert "secret-flag" not in str(following)


async def test_id_details_auth_active_hidden_and_unique_solves(client, settings, session):
    first = await make_user(session, username="first")
    second = await make_user(session, username="second")
    challenge = await make_challenge(
        session, settings, slug="concealed", flag="secret", category="gold", hidden=True
    )
    inactive = await make_challenge(
        session, settings, slug="inactive", flag="other", is_active=False
    )
    path = f"/api/challenges/id/{challenge.id}"
    first_headers = session_cookie(settings, first)
    second_headers = session_cookie(settings, second)
    assert (await client.get(path)).status_code == 401
    assert (await client.get(path, headers={"Cookie": "fwf_saml_session=bad"})).status_code == 401
    inactive_response = await client.get(f"/api/challenges/id/{inactive.id}", headers=first_headers)
    assert inactive_response.status_code == 404
    assert (await client.get("/api/challenges/id/999999", headers=first_headers)).status_code == 404
    response = await client.get(path, headers=first_headers)
    assert response.status_code == 200
    assert response.json()["id"] == challenge.id
    assert response.json()["title"] == "<hidden>"
    assert response.json()["description"] == "<hidden>"
    assert response.json()["hidden"] is True
    assert response.json()["solved"] is False
    assert response.json()["solve_count"] == 0
    assert (await client.get("/api/challenges/concealed")).json()["id"] == challenge.id
    assert (await client.get("/api/challenges")).json()[0]["id"] == challenge.id
    for headers in (first_headers, first_headers, second_headers):
        result = await client.post(
            "/api/challenges/concealed/submit", json={"flag": "secret"}, headers=headers
        )
        assert result.json()["correct"] is True
    assert (await client.get(path, headers=first_headers)).json()["solve_count"] == 2
    assert (await client.get(path, headers=first_headers)).json()["solved"] is True
    second_detail = await client.get(path, headers=second_headers)
    assert second_detail.json()["solved"] is True



async def test_list_and_submit_flow(client, settings, session):
    user = await make_user(session)
    await make_challenge(session, settings, slug="warmup", flag="xsecurity{Hi}", points=100)
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
        "/api/challenges/warmup/submit", json={"flag": "  XSECURITY{hi} "}, headers=headers
    )
    assert {k: v for k, v in right.json().items() if k != "event_id"} == {
        "correct": True,
        "already_solved": False,
        "points_awarded": 100,
        "total_score": 100,
        "message": "Nice work! +100 points.",
    }
    assert right.json()["event_id"] > wrong.json()["event_id"]

    private = await client.get(
        "/api/challenges/notifications",
        params={"gold_after": wrong.json()["event_id"]},
        headers=headers,
    )
    assert private.status_code == 200
    assert private.json()["gold"] == [{
        "id": right.json()["event_id"], "outcome": "correct",
        "points": 100, "challenge_id": listing.json()[0]["id"],
        "time": private.json()["gold"][0]["time"],
    }]
    assert "XSECURITY" not in str(private.json())

    again = await client.post(
        "/api/challenges/warmup/submit", json={"flag": "xsecurity{Hi}"}, headers=headers
    )
    assert again.json()["already_solved"] is True
    assert again.json()["points_awarded"] == 0
    assert again.json()["total_score"] == 100
    page = (await client.get(
        "/api/challenges/notifications", params={"gold_after": right.json()["event_id"]},
        headers=headers,
    )).json()
    assert [event["outcome"] for event in page["gold"]] == ["already_solved"]

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
    await make_challenge(session, settings, slug="cs", flag="xsecurity{CaSe}", case_sensitive=True)
    headers = session_cookie(settings, user)
    assert (
        await client.post(
            "/api/challenges/cs/submit", json={"flag": "xsecurity{case}"}, headers=headers
        )
    ).json()["correct"] is False
    assert (
        await client.post(
            "/api/challenges/cs/submit", json={"flag": "xsecurity{CaSe}"}, headers=headers
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


async def test_flag_only_submit_awards_each_user_and_group_once(client, settings, session):
    alice = await make_user(session, username="flag-alice", groups=["Shared"])
    bob = await make_user(session, username="flag-bob", groups=["Shared"])
    challenge = await make_challenge(
        session, settings, slug="flag-only", flag="ctf{One}", points=175
    )

    alice_headers = session_cookie(settings, alice)
    first = await client.post(
        "/api/challenges/submit", json={"flag": "  CTF{oNe}  "}, headers=alice_headers
    )
    assert first.status_code == 200
    assert {k: v for k, v in first.json().items() if k != "event_id"} == {
        "correct": True,
        "already_solved": False,
        "points_awarded": 175,
        "total_score": 175,
        "message": "Nice work! +175 points.",
    }

    repeat = await client.post(
        "/api/challenges/submit", json={"flag": "ctf{one}"}, headers=alice_headers
    )
    assert repeat.json()["correct"] is True
    assert repeat.json()["already_solved"] is True
    assert repeat.json()["points_awarded"] == 0

    bob_result = await client.post(
        "/api/challenges/submit",
        json={"flag": "ctf{one}"},
        headers=session_cookie(settings, bob),
    )
    assert bob_result.json()["points_awarded"] == 175
    solves = (await session.execute(select(Solve))).scalars().all()
    credits = (await session.execute(select(GroupChallengeCredit))).scalars().all()
    assert {(solve.user_id, solve.challenge_id) for solve in solves} == {
        (alice.id, challenge.id),
        (bob.id, challenge.id),
    }
    assert [(credit.group_name, credit.challenge_id) for credit in credits] == [
        ("Shared", challenge.id)
    ]


async def test_flag_only_submit_auth_inactive_and_case_sensitive(client, settings, session):
    strict = await make_challenge(
        session,
        settings,
        slug="strict",
        flag="ctf{CaSe}",
        case_sensitive=True,
    )
    await make_challenge(
        session,
        settings,
        slug="inactive",
        flag="ctf{inactive}",
        is_active=False,
    )
    assert (
        await client.post("/api/challenges/submit", json={"flag": "ctf{CaSe}"})
    ).status_code == 401

    user = await make_user(session, username="strict-user")
    headers = session_cookie(settings, user)
    wrong_case = await client.post(
        "/api/challenges/submit", json={"flag": "ctf{case}"}, headers=headers
    )
    inactive = await client.post(
        "/api/challenges/submit", json={"flag": "ctf{inactive}"}, headers=headers
    )
    assert wrong_case.json()["correct"] is False
    assert {k: v for k, v in inactive.json().items() if k != "event_id"} == {
        k: v for k, v in wrong_case.json().items() if k != "event_id"
    }

    exact = await client.post(
        "/api/challenges/submit", json={"flag": "  ctf{CaSe} "}, headers=headers
    )
    assert exact.json()["correct"] is True
    submissions = (await session.execute(select(Submission))).scalars().all()
    assert [submission.challenge_id for submission in submissions] == [None, None, strict.id]


async def test_unknown_and_ambiguous_flags_are_generic_counted_and_never_awarded(
    client, settings, session
):
    user = await make_user(session, username="unresolved")
    first = await make_challenge(session, settings, slug="duplicate-a", flag="ctf{duplicate}")
    second = await make_challenge(session, settings, slug="duplicate-b", flag="CTF{DUPLICATE}")
    headers = session_cookie(settings, user)

    unknown = await client.post(
        "/api/challenges/submit", json={"flag": "ctf{unknown}"}, headers=headers
    )
    ambiguous = await client.post(
        "/api/challenges/submit", json={"flag": "ctf{duplicate}"}, headers=headers
    )
    legacy_first = await client.post(
        f"/api/challenges/{first.slug}/submit",
        json={"flag": "ctf{duplicate}"},
        headers=headers,
    )
    legacy_second = await client.post(
        f"/api/challenges/{second.slug}/submit",
        json={"flag": "ctf{duplicate}"},
        headers=headers,
    )
    for response in (unknown, ambiguous, legacy_first, legacy_second):
        assert response.status_code == 200
        assert response.json()["correct"] is False
        assert response.json()["message"] == "That is not the flag."
    assert {k: v for k, v in unknown.json().items() if k != "event_id"} == {
        k: v for k, v in ambiguous.json().items() if k != "event_id"
    }
    assert not (await session.execute(select(Solve))).scalars().all()

    # Both unresolved attempts count, as do the two legacy attempts.
    fifth = await client.post(
        "/api/challenges/submit", json={"flag": "another unknown"}, headers=headers
    )
    assert fifth.status_code == 200
    limited = await client.post(
        "/api/challenges/submit", json={"flag": "still unknown"}, headers=headers
    )
    assert limited.status_code == 429

    submissions = (await session.execute(select(Submission))).scalars().all()
    assert [submission.challenge_id for submission in submissions] == [
        None,
        None,
        first.id,
        second.id,
        None,
    ]
    assert all(submission.correct is False for submission in submissions)


async def test_flag_only_submission_does_not_persist_or_emit_plaintext(
    client, settings, session
):
    plaintext = "ctf{never-store-or-log-me}"
    user = await make_user(session, username="no-leak")
    challenge = await make_challenge(session, settings, slug="no-leak", flag=plaintext)
    response = await client.post(
        "/api/challenges/submit",
        json={"flag": plaintext},
        headers=session_cookie(settings, user),
    )
    assert response.status_code == 200
    assert plaintext not in response.text
    assert plaintext not in challenge.flag_hash
    assert "flag" not in Submission.__table__.columns
    audits = (await session.execute(select(AuditLog))).scalars().all()
    assert plaintext not in repr([audit.detail for audit in audits])


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

    # The leaderboard is available to every authenticated player, not just admins.
    alice_headers = session_cookie(settings, a)
    board_response = await client.get("/api/leaderboard", headers=alice_headers)
    assert board_response.status_code == 200
    board = board_response.json()
    assert [(e["rank"], e["username"], e["score"], e["solves"]) for e in board] == [
        (1, "bob", 350, 2),
        (2, "alice", 100, 1),
    ]
    assert [e["failed_attempts"] for e in board] == [0, 0]
    # limit only trims the list; ranks stay absolute
    top1 = (await client.get("/api/leaderboard?limit=1", headers=alice_headers)).json()
    assert [e["username"] for e in top1] == ["bob"]

    mine = (await client.get("/api/leaderboard/me", headers=alice_headers)).json()
    assert mine == {
        "entry": {
            "rank": 2,
            "username": "alice",
            "full_name": "Alice",
            "score": 100,
            "solves": 1,
            "failed_attempts": 0,
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
    assert unranked["entry"]["failed_attempts"] == 0
    assert unranked["total_players"] == 2


async def test_failed_attempts_count_persisted_outcomes_without_changing_rank(
    client, settings, session
):
    player = await make_user(session, username="attempt-player")
    other = await make_user(session, username="attempt-other")
    await make_challenge(session, settings, slug="attempt-one", flag="valid-one")
    await make_challenge(session, settings, slug="attempt-two", flag="valid-two")
    player_headers = session_cookie(settings, player)
    other_headers = session_cookie(settings, other)

    async def submit(path, flag, headers=player_headers):
        return await client.post(path, json={"flag": flag}, headers=headers)

    # Anonymous, invalid and missing routes do not persist an adjudicated attempt.
    assert (await client.post(
        "/api/challenges/submit", json={"flag": "no-session"}
    )).status_code == 401
    assert (await submit("/api/challenges/missing/submit", "wrong")).status_code == 404
    assert (await submit("/api/challenges/submit", "")).status_code == 422

    for path, flag in [
        ("/api/challenges/submit", "wrong-1"),
        ("/api/challenges/attempt-one/submit", "wrong-2"),
    ]:
        result = await submit(path, flag)
        assert result.status_code == 200
        assert result.json()["correct"] is False
    assert (await submit("/api/challenges/attempt-one/submit", "valid-one")).json()["correct"]
    repeat = await submit("/api/challenges/submit", "valid-one")
    assert repeat.json()["correct"] and repeat.json()["already_solved"]
    assert (await submit(
        "/api/challenges/attempt-one/submit", "wrong-after-solve"
    )).json()["correct"] is False
    assert (await submit("/api/challenges/submit", "rate-limited")).status_code == 429
    assert (await submit(
        "/api/challenges/attempt-two/submit", "valid-two", other_headers
    )).json()["correct"]

    board = (await client.get("/api/leaderboard", headers=player_headers)).json()
    assert [(row["username"], row["score"], row["solves"], row["failed_attempts"])
            for row in board] == [
        ("attempt-other", 100, 1, 0),
        ("attempt-player", 100, 1, 3),
    ]
    assert (await client.get("/api/leaderboard?limit=1", headers=other_headers)).json() == [
        board[0]
    ]
    mine = (await client.get("/api/leaderboard/me", headers=player_headers)).json()
    assert mine["entry"]["failed_attempts"] == 3
    assert mine["entry"]["rank"] == next(
        row["rank"] for row in board if row["username"] == "attempt-player"
    )
    assert (await client.get("/api/leaderboard/me", headers=other_headers)).json()[
        "entry"
    ]["failed_attempts"] == 0

    # Historical wrong attempts also appear for a user who has never solved anything.
    unsolved = await make_user(session, username="attempt-unsolved")
    unsolved_headers = session_cookie(settings, unsolved)
    assert (await submit(
        "/api/challenges/submit", "wrong-4", unsolved_headers
    )).json()["correct"] is False
    unranked = (await client.get("/api/leaderboard/me", headers=unsolved_headers)).json()
    assert unranked["entry"]["rank"] is None
    assert unranked["entry"]["failed_attempts"] == 1
    assert unranked["total_players"] == 2


async def test_leaderboard_authentication_rejections(client, settings, session):
    active = await make_user(session, username="active")
    inactive = await make_user(session, username="inactive")
    inactive.is_active = False
    await session.commit()

    now = int(time.time())
    expired_token = jwt.encode(
        {
            "sub": str(active.id),
            "username": active.username,
            "aud": SESSION_AUDIENCE,
            "iat": now - 60,
            "exp": now - 1,
        },
        settings.session_secret.get_secret_value(),
        algorithm="HS256",
    )
    cookie_name = settings.session_cookie_name
    rejected_headers = [
        {"Cookie": f"{cookie_name}=not-a-valid-session"},
        {"Cookie": f"{cookie_name}={expired_token}"},
        session_cookie(settings, inactive),
    ]

    # Anonymous top-list requests are rejected both with and without a limit.
    for path in ("/api/leaderboard", "/api/leaderboard?limit=1", "/api/leaderboard/me"):
        assert (await client.get(path)).status_code == 401

    # Invalid, expired, and inactive sessions are rejected on both endpoints.
    for headers in rejected_headers:
        for path in ("/api/leaderboard", "/api/leaderboard/me"):
            response = await client.get(path, headers=headers)
            assert response.status_code == 401
            assert response.json() == {"detail": "Not authenticated"}


async def test_leaderboard_ties_are_stably_ranked(client, settings, session):
    first = await make_user(session, username="first")
    second = await make_user(session, username="second")
    await make_challenge(session, settings, slug="tie", flag="tie", points=100)

    for user in (first, second):
        response = await client.post(
            "/api/challenges/tie/submit",
            json={"flag": "tie"},
            headers=session_cookie(settings, user),
        )
        assert response.json()["correct"] is True

    board = (
        await client.get("/api/leaderboard", headers=session_cookie(settings, second))
    ).json()
    assert [(entry["rank"], entry["username"], entry["score"]) for entry in board] == [
        (1, "first", 100),
        (2, "second", 100),
    ]


async def test_group_scoring_uses_first_solve_memberships(client, settings, session):
    alice = await make_user(
        session,
        username="alice",
        groups=[" Shared ", "Alpha", "Shared", "", " alpha "],
    )
    bob = await make_user(session, username="bob", groups=["Shared", "Bravo"])
    ungrouped = await make_user(session, username="ungrouped")
    first = await make_challenge(session, settings, slug="first", flag="f1", points=100)
    await make_challenge(session, settings, slug="second", flag="f2", points=250)

    alice_headers = session_cookie(settings, alice)
    bob_headers = session_cookie(settings, bob)
    ungrouped_headers = session_cookie(settings, ungrouped)

    assert (
        await client.post(
            "/api/challenges/first/submit", json={"flag": "f1"}, headers=alice_headers
        )
    ).json()["points_awarded"] == 100

    # A different user still earns their personal solve, while Shared remains credited once.
    assert (
        await client.post(
            "/api/challenges/first/submit", json={"flag": "f1"}, headers=bob_headers
        )
    ).json()["points_awarded"] == 100

    # No memberships creates no credit, and changing memberships after a solve cannot add one.
    assert (
        await client.post(
            "/api/challenges/first/submit", json={"flag": "f1"}, headers=ungrouped_headers
        )
    ).json()["points_awarded"] == 100
    ungrouped.groups = ["Late"]
    alice.groups = ["Late"]
    await session.commit()
    for headers in (ungrouped_headers, alice_headers):
        repeat = await client.post(
            "/api/challenges/first/submit", json={"flag": "f1"}, headers=headers
        )
        assert repeat.json()["already_solved"] is True
        assert repeat.json()["points_awarded"] == 0

    # Multiple challenges sum frozen challenge points for memberships at each first solve.
    assert (
        await client.post(
            "/api/challenges/second/submit", json={"flag": "f2"}, headers=bob_headers
        )
    ).json()["points_awarded"] == 250

    credits = (await session.execute(select(GroupChallengeCredit))).scalars().all()
    assert len(credits) == 6
    first_credits = {
        credit.group_name: (credit.points_awarded, credit.credited_by_user_id)
        for credit in credits
        if credit.challenge_id == first.id
    }
    assert set(first_credits) == {"Alpha", "Shared", "alpha", "Bravo"}
    assert first_credits["Shared"] == (100, alice.id)
    assert all(points == 100 for points, _ in first_credits.values())
    assert "Late" not in {credit.group_name for credit in credits}

    board_response = await client.get("/api/leaderboard/groups", headers=alice_headers)
    assert board_response.status_code == 200
    board = board_response.json()
    ranking = [
        (entry["rank"], entry["group_name"], entry["score"], entry["solves"])
        for entry in board
    ]
    assert ranking == [
        (1, "Bravo", 350, 2),
        (2, "Shared", 350, 2),
        (3, "Alpha", 100, 1),
        (4, "alpha", 100, 1),
    ]
    assert set(board[0]) == {"rank", "group_name", "score", "solves", "last_solve_at"}
    assert (await client.get("/api/leaderboard/groups")).status_code == 401
    assert (
        await client.get("/api/leaderboard/groups?limit=0", headers=alice_headers)
    ).status_code == 422
    assert (
        await client.get("/api/leaderboard/groups?limit=201", headers=alice_headers)
    ).status_code == 422


async def test_group_credit_survives_credited_user_deletion(client, settings, session):
    user = await make_user(session, groups=["Durable"])
    await make_challenge(session, settings, slug="durable", flag="flag")
    response = await client.post(
        "/api/challenges/durable/submit",
        json={"flag": "flag"},
        headers=session_cookie(settings, user),
    )
    assert response.json()["points_awarded"] == 100

    await session.delete(user)
    await session.commit()

    credit = (await session.execute(select(GroupChallengeCredit))).scalar_one()
    assert credit.group_name == "Durable"
    assert credit.points_awarded == 100
    assert credit.credited_by_user_id is None


async def test_admin_gating_and_upsert(client, settings, session):
    player = await make_user(session, username="player")
    admin = await make_user(
        session, username="admin", is_admin=True, groups=["funwithflags-admins"]
    )
    admin.okta_sub = "saml:" + ("a" * 64)
    admin.last_login_at = datetime.now(UTC)
    await session.commit()

    assert (
        await client.get("/api/admin/challenges", headers=session_cookie(settings, player))
    ).status_code == 403

    body = {"title": "New", "category": "web", "points": 300, "flag": "xsecurity{new}"}
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
        json={"flag": "xsecurity{new}"},
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
