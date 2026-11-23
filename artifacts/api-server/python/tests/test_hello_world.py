"""Hello World uses the real import and award paths with in-memory synthetic data."""

import pytest
from sqlalchemy import select

from app import crack_hashes
from app.models import Challenge, GroupChallengeCredit, Solve
from app.security import hash_flag
from app.terminal_challenges import INTRO_PUZZLE, TERMINAL_CHALLENGES, metadata
from tests.conftest import make_challenge, make_user, session_cookie
from tests.test_flag_admin import _member


async def _catalog_without_intro(session, settings):
    for slug, title, description, flag in TERMINAL_CHALLENGES:
        if slug == INTRO_PUZZLE[0]:
            continue
        category, points = metadata(slug)
        row = await make_challenge(
            session,
            settings,
            slug=slug,
            flag=flag,
            category=category,
            points=points,
        )
        row.title, row.description = title, description
    await session.commit()


async def _awards(session):
    # Include identifiers, timestamps and immutable values, not just score totals.
    return {
        model.__name__: [
            tuple(getattr(row, column.name) for column in model.__table__.columns)
            for row in (await session.scalars(select(model).order_by(model.id))).all()
        ]
        for model in (Solve, GroupChallengeCredit)
    }


async def test_hello_world_explicit_import_and_normal_scoring(
    monkeypatch,
    client,
    settings,
    session,
):
    monkeypatch.setattr(crack_hashes, "PUZZLES", ())
    await _catalog_without_intro(session, settings)
    operator = await _member(session)
    alice = await make_user(session, username="intro-alice", groups=["Shared"])
    bob = await make_user(session, username="intro-bob", groups=["Shared"])
    ah, bh = session_cookie(settings, alice), session_cookie(settings, bob)
    admin = session_cookie(settings, operator)
    endpoint = "/api/flag-admin/import-challenges"
    payload = {"terminal_missing": ["hello-world"]}
    await make_challenge(session, settings, slug="unrelated", flag="other", points=37)
    assert (
        await client.post(
            "/api/challenges/submit",
            json={"flag": "other"},
            headers=ah,
        )
    ).json()["points_awarded"] == 37
    awards_before = await _awards(session)

    assert (await client.get(endpoint)).status_code == 401
    assert (await client.post(endpoint, json=payload)).status_code == 401
    assert (await client.get(endpoint, headers=ah)).status_code == 403
    assert (await client.post(endpoint, json=payload, headers=ah)).status_code == 403
    preview = await client.get(endpoint, headers=admin)
    assert preview.status_code == 200
    assert preview.json() == {
        "puzzles": [],
        "terminal": [
            {
                "slug": "hello-world",
                "title": "Hello World",
                "points": 5,
                "missing": True,
            }
        ],
    }
    assert "hello_world" not in preview.text
    assert await session.scalar(select(Challenge).where(Challenge.slug == "hello-world")) is None
    imported = await client.post(endpoint, json=payload, headers=admin)
    assert imported.status_code == 200
    assert imported.json() == {"created": 1, "unchanged": len(TERMINAL_CHALLENGES) - 1}
    assert await _awards(session) == awards_before
    row = await session.scalar(select(Challenge).where(Challenge.slug == "hello-world"))
    assert (row.category, row.points, row.description) == ("Intro", 5, INTRO_PUZZLE[2])
    assert "help" in row.description
    assert row.flag_hash == hash_flag(settings, "hello_world", case_sensitive=False)
    assert row.is_active and not row.hidden and not row.case_sensitive
    identity = (row.id, row.flag_hash, row.updated_at)

    assert (
        await client.post(
            "/api/challenges/submit",
            json={"flag": "hello_world"},
        )
    ).status_code == 401
    for headers, total in ((ah, 42), (bh, 5)):
        first = await client.post(
            "/api/challenges/submit",
            json={"flag": "hello_world"},
            headers=headers,
        )
        assert first.status_code == 200
        assert first.json()["correct"] is True
        assert first.json()["already_solved"] is False
        assert first.json()["points_awarded"] == 5
        assert first.json()["total_score"] == total
        repeat = await client.post(
            "/api/challenges/submit",
            json={"flag": "hello_world"},
            headers=headers,
        )
        assert repeat.json()["already_solved"] is True
        assert repeat.json()["points_awarded"] == 0
        assert repeat.json()["total_score"] == total
    solves = (await session.scalars(select(Solve).where(Solve.challenge_id == row.id))).all()
    credits = (
        await session.scalars(
            select(GroupChallengeCredit).where(GroupChallengeCredit.challenge_id == row.id)
        )
    ).all()
    assert {(s.user_id, s.points_awarded) for s in solves} == {(alice.id, 5), (bob.id, 5)}
    assert [(c.group_name, c.points_awarded) for c in credits] == [("Shared", 5)]
    board = (await client.get("/api/leaderboard", headers=ah)).json()
    assert {p["username"]: p["score"] for p in board} == {"intro-alice": 42, "intro-bob": 5}
    groups = (await client.get("/api/leaderboard/groups", headers=ah)).json()
    assert [(g["group_name"], g["score"], g["solves"]) for g in groups] == [("Shared", 42, 2)]

    awards_after = await _awards(session)
    for model, rows in awards_before.items():
        assert all(award in awards_after[model] for award in rows)
    assert (await client.get(endpoint, headers=admin)).json() == {"puzzles": [], "terminal": []}
    assert (await client.post(endpoint, json=payload, headers=admin)).status_code == 409
    again = await client.post(endpoint, json={"terminal_missing": []}, headers=admin)
    assert again.json() == {"created": 0, "unchanged": len(TERMINAL_CHALLENGES)}
    assert await _awards(session) == awards_after
    await session.refresh(row)
    assert (row.id, row.flag_hash, row.updated_at) == identity
    assert (
        len((await session.scalars(select(Challenge).where(Challenge.slug == "hello-world"))).all())
        == 1
    )


@pytest.mark.parametrize(
    "slug,flag",
    [
        ("hello-world", "different-answer"),
        ("unrelated-collision", "hello_world"),
    ],
)
async def test_hello_world_conflict_aborts_entire_import(
    monkeypatch,
    client,
    settings,
    session,
    slug,
    flag,
):
    monkeypatch.setattr(crack_hashes, "PUZZLES", ())
    operator = await _member(session)
    headers = session_cookie(settings, operator)
    endpoint = "/api/flag-admin/import-challenges"
    preview = (await client.get(endpoint, headers=headers)).json()
    existing = await make_challenge(session, settings, slug=slug, flag=flag, points=123)
    response = await client.post(
        endpoint,
        headers=headers,
        json={
            "terminal_missing": [p["slug"] for p in preview["terminal"]],
        },
    )
    assert response.status_code == 409
    session.expire_all()
    rows = (await session.scalars(select(Challenge))).all()
    assert len(rows) == 1 and rows[0].id == existing.id and rows[0].points == 123
