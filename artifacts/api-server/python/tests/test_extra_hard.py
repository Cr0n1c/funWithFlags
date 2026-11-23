"""Extra-hard import verifies bcrypt and derives the same SHA1 flag format."""

import hashlib

import bcrypt
from sqlalchemy import select

from app import crack_hashes
from app.models import Challenge
from tests.conftest import make_user, session_cookie
from tests.test_flag_admin import _member


async def test_extra_hard_import_verifies_plaintext_and_awards_once(
    monkeypatch,
    client,
    settings,
    session,
):
    puzzle = crack_hashes.PUZZLES[-1]
    assert puzzle[:4] == (
        "crack-the-hash-extra-hard",
        "Crack The Hash: Extra Hard",
        750,
        "bcrypt",
    )
    assert puzzle[4] == "$2a$08$VP3PiYeRMjPBBqpLizfKduLJ7qBTOiaBRZ1pmoGh3sbR3/jluJl7e"
    assert puzzle[5] == (
        'The string starts with "security" and contains only lowercase letters and numbers. '
        "No spaces, special characters, or uppercase letters."
    )
    # Never claim to know the requested hash's plaintext: use a local synthetic
    # cost-8 $2a$ hash to exercise the actual bcrypt verification path.
    word = "synthetic-extra-hard-fixture"
    digest = bcrypt.hashpw(word.encode(), bcrypt.gensalt(rounds=8, prefix=b"2a")).decode()
    monkeypatch.setattr(crack_hashes, "PUZZLES", ((*puzzle[:4], digest, puzzle[5]),))
    admin = session_cookie(settings, await _member(session))
    player = session_cookie(settings, await make_user(session, username="extra-hard-player"))
    endpoint = "/api/flag-admin/import-challenges"
    preview = (await client.get(endpoint, headers=admin)).json()
    assert preview["puzzles"][0]["points"] == 750
    payload = {
        "extra-hard": "incorrect-fixture",
        "terminal_missing": [p["slug"] for p in preview["terminal"]],
    }
    assert (await client.post(endpoint, headers=player, json=payload)).status_code == 403
    rejected = await client.post(endpoint, headers=admin, json=payload)
    assert rejected.status_code == 400
    assert "incorrect-fixture" not in rejected.text
    assert await session.scalar(select(Challenge.id)) is None
    payload["extra-hard"] = word
    created = await client.post(endpoint, headers=admin, json=payload)
    assert created.status_code == 200
    row = await session.scalar(select(Challenge).where(Challenge.slug == puzzle[0]))
    assert (row.category, row.points) == ("cracking", 750)
    assert word not in row.description
    assert digest in row.description and "SHA1" in row.description
    assert f"Hint: {puzzle[5]}" in row.description
    answer = hashlib.sha1(word.encode()).hexdigest()
    for points in (750, 0):
        result = await client.post(
            "/api/challenges/submit",
            headers=player,
            json={"flag": answer},
        )
        assert result.status_code == 200
        assert result.json()["correct"] is True
        assert result.json()["points_awarded"] == points
