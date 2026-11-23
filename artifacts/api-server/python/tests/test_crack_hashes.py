from __future__ import annotations

import hashlib

import pytest
from pydantic import SecretStr
from sqlalchemy import select

from app import crack_hashes
from app.models import Challenge, Solve
from app.security import hash_flag
from tests.conftest import make_challenge, make_user


async def test_explicit_dev_only_provisioning_is_idempotent_and_preserves_rows(
    monkeypatch, settings, session
):
    word = "a-local-test-word"
    test_puzzles = tuple(
        (f"test-{i}", f"Test {i}", i * 10, "MD5", hashlib.md5(word.encode()).hexdigest(), "")
        for i in range(1, 4)
    )
    monkeypatch.setattr(crack_hashes, "PUZZLES", test_puzzles)
    words = {p[0]: word for p in test_puzzles}
    with pytest.raises(ValueError, match="Explicit ENVIRONMENT"):
        await crack_hashes.provision(session, settings, words)
    dev_settings = settings.model_copy(
        update={"environment": "development", "database_url": SecretStr("sqlite+aiosqlite:///:memory:")}
    )
    monkeypatch.setenv("ENVIRONMENT", "development")
    with pytest.raises(ValueError, match="Hash mismatch"):
        crack_hashes.verify_words({**words, "test-2": "wrong"})
    assert (await session.execute(select(Challenge))).scalars().all() == []
    # Each puzzle must have a distinct flag; collisions fail without writing.
    with pytest.raises(ValueError, match="Flag collision"):
        await crack_hashes.provision(session, dev_settings, words)
    assert (await session.execute(select(Challenge))).scalars().all() == []

    distinct_words = {p[0]: f"{word}-{i}" for i, p in enumerate(test_puzzles)}
    monkeypatch.setattr(
        crack_hashes, "PUZZLES",
        tuple(
            (
                slug, title, points, algo,
                hashlib.md5(distinct_words[slug].encode()).hexdigest(), hint,
            )
            for slug, title, points, algo, _, hint in test_puzzles
        ),
    )
    assert await crack_hashes.provision(session, dev_settings, distinct_words) == {
        "created": 3, "unchanged": 0
    }
    rows = (await session.execute(select(Challenge))).scalars().all()
    assert len(rows) == 3
    assert all(row.category == "cracking" and row.is_active and not row.hidden for row in rows)
    assert all("SHA1" in row.description and "no wrapper" in row.description for row in rows)
    assert all(word not in row.description for row in rows)
    owner = await make_user(session)
    session.add(Solve(user_id=owner.id, challenge_id=rows[0].id, points_awarded=rows[0].points))
    await session.commit()
    assert await crack_hashes.provision(session, dev_settings, {}) == {
        "created": 0, "unchanged": 3
    }
    assert len((await session.execute(select(Solve))).scalars().all()) == 1
    rows[0].category = "gold"  # Legacy row is left untouched by the import.
    original_id = rows[0].id
    await session.commit()
    assert await crack_hashes.provision(session, dev_settings, {}) == {
        "created": 0, "unchanged": 3
    }
    assert rows[0].id == original_id
    assert rows[0].category == "gold"
    assert len((await session.execute(select(Solve))).scalars().all()) == 1
    rows[1].title = "Existing user title"
    await session.commit()
    with pytest.raises(ValueError, match="differs"):
        await crack_hashes.provision(session, dev_settings, {})
    assert rows[1].title == "Existing user title"


async def test_shared_import_rejects_case_sensitive_ambiguity_and_preserves_scores(
    monkeypatch, settings, session
):
    words = {
        f"crack-the-hash-{name}": f"offline-word-{name}"
        for name in ("easy", "medium", "hard")
    }
    monkeypatch.setattr(crack_hashes, "PUZZLES", tuple(
        (slug, f"Crack The Hash: {name.title()}", points, "MD5",
         hashlib.md5(words[slug].encode()).hexdigest(), "")
        for (name, points), slug in zip(
            (("easy", 50), ("medium", 150), ("hard", 400)), words, strict=True
        )
    ))
    owner = await make_user(session)
    old = await make_challenge(session, settings, slug="old", flag="old-answer", points=10)
    session.add(Solve(user_id=owner.id, challenge_id=old.id, points_awarded=10))
    await session.commit()
    assert await crack_hashes.create_challenges(session, settings, words) == {
        "created": 3, "unchanged": 0
    }
    assert await crack_hashes.create_challenges(session, settings, {}) == {
        "created": 0, "unchanged": 3
    }
    easy_legacy = (await session.execute(select(Challenge).where(
        Challenge.slug == "crack-the-hash-easy"
    ))).scalar_one()
    easy_legacy.category = "gold"
    await session.commit()
    assert await crack_hashes.create_challenges(session, settings, {}) == {
        "created": 0, "unchanged": 3
    }
    assert easy_legacy.category == "gold"
    easy = (await session.execute(select(Challenge).where(
        Challenge.slug == "crack-the-hash-easy"
    ))).scalar_one()
    answer = hashlib.sha1(words["crack-the-hash-easy"].encode()).hexdigest()
    assert easy.flag_hash == hash_flag(settings, answer, case_sensitive=False)
    assert await session.scalar(select(Solve.points_awarded)) == 10
    easy.title = "Changed"
    await session.commit()
    with pytest.raises(ValueError, match="differs"):
        await crack_hashes.create_challenges(session, settings, {})
    easy.title = "Crack The Hash: Easy"
    await session.commit()
    old.case_sensitive = True
    await session.commit()
    hard = (await session.execute(select(Challenge).where(
        Challenge.slug == "crack-the-hash-hard"
    ))).scalar_one()
    await session.delete(hard)
    await session.commit()
    with pytest.raises(ValueError, match="Flag collision"):
        await crack_hashes.create_challenges(session, settings, {
            "crack-the-hash-hard": words["crack-the-hash-hard"]
        })
    assert await session.scalar(select(Solve.points_awarded)) == 10