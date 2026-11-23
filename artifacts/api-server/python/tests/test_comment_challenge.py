"""The deliberate production comment uses the normal import and scoring paths."""

from pathlib import Path

from sqlalchemy import select

from app import crack_hashes
from app.models import Challenge
from app.terminal_challenges import COMMENT_PUZZLE, TERMINAL_CHALLENGES
from tests.conftest import make_user, session_cookie
from tests.test_flag_admin import _member

INDEX_HTML = Path(__file__).resolve().parents[3] / "fun-with-flags/index.html"


async def test_comment_import_catalog_and_one_time_award(monkeypatch, client, settings, session):
    monkeypatch.setattr(crack_hashes, "PUZZLES", ())
    admin = session_cookie(settings, await _member(session))
    player = session_cookie(settings, await make_user(session, username="comment-player"))
    endpoint = "/api/flag-admin/import-challenges"
    preview = (await client.get(endpoint, headers=admin)).json()
    item = next(p for p in preview["terminal"] if p["slug"] == COMMENT_PUZZLE[0])
    assert item == {
        "slug": COMMENT_PUZZLE[0],
        "title": COMMENT_PUZZLE[1],
        "points": 15,
        "missing": True,
    }
    payload = {"terminal_missing": [p["slug"] for p in preview["terminal"]]}
    imported = await client.post(endpoint, headers=admin, json=payload)
    assert imported.status_code == 200
    assert imported.json()["created"] == len(TERMINAL_CHALLENGES)
    row = await session.scalar(select(Challenge).where(Challenge.slug == COMMENT_PUZZLE[0]))
    assert (row.title, row.description, row.category, row.points) == (
        COMMENT_PUZZLE[1],
        COMMENT_PUZZLE[2],
        "OWASP",
        15,
    )
    assert row.is_active and not row.hidden
    assert COMMENT_PUZZLE[3] not in row.flag_hash
    listing = await client.get("/api/challenges?category=OWASP", headers=player)
    assert listing.status_code == 200
    assert COMMENT_PUZZLE[1] in listing.text
    assert COMMENT_PUZZLE[3] not in listing.text
    for points in (15, 0):
        result = await client.post(
            "/api/challenges/submit",
            headers=player,
            json={"flag": COMMENT_PUZZLE[3]},
        )
        assert result.status_code == 200
        assert result.json()["correct"] is True
        assert result.json()["points_awarded"] == points
    assert f'<!-- {{ "flag": "{COMMENT_PUZZLE[3]}" }} -->' in INDEX_HTML.read_text()
