from sqlalchemy import select

from app.bundle_challenge import DESCRIPTION, FLAG, SLUG, TITLE
from app.models import Solve
from app.terminal_challenges import prepare_terminal_challenges, terminal_status
from app.training import PUZZLES
from tests.conftest import make_challenge, make_user, session_cookie


async def test_training_is_fictional_and_requires_sign_in(client, settings, session):
    user = await make_user(session, username="lab-learner")
    headers = session_cookie(settings, user)
    for path in ("/api/training/invoices/1043", "/api/training/files?path=../internal/release.txt"):
        assert (await client.get(path)).status_code == 401
    assert (await client.post("/api/training/profile", json={"role": "admin"})).status_code == 401
    baseline = await client.get("/api/training/invoices/1042", headers=headers)
    assert "flag" not in baseline.json()
    assert (await client.get("/api/training/invoices/1043", headers=headers)).json()[
        "flag"
    ] == PUZZLES[0][3]
    assert (await client.get("/api/training/invoices/1", headers=headers)).status_code == 404
    assert (
        "flag" not in (await client.post("/api/training/profile", headers=headers, json={})).json()
    )
    promoted = await client.post("/api/training/profile", headers=headers, json={"role": "admin"})
    assert promoted.json()["flag"] == PUZZLES[1][3]
    assert (await client.post("/api/training/profile", headers=headers, json={})).json()["profile"][
        "role"
    ] == "reader"
    assert (
        await client.get(
            "/api/training/files", headers=headers, params={"path": "../internal/release.txt"}
        )
    ).json()["content"] == PUZZLES[2][3]
    for path in ("../../etc/passwd", "/etc/passwd", "../app/config.py"):
        assert (
            await client.get("/api/training/files", headers=headers, params={"path": path})
        ).status_code == 404
    await session.refresh(user)
    assert not user.is_admin and user.groups == []

    old = await make_challenge(session, settings, slug=SLUG, flag=FLAG, points=150, category="gold")
    old.title, old.description = TITLE, DESCRIPTION
    await session.commit()
    previous = await client.post("/api/challenges/submit", headers=headers, json={"flag": FLAG})
    assert previous.json()["points_awarded"] == 150
    old_id = old.id
    status = await terminal_status(session, settings)
    session.add_all(
        await prepare_terminal_challenges(
            session,
            settings,
            {item["slug"] for item in status if item["missing"]},
        )
    )
    await session.commit()
    await session.refresh(old)
    assert old.points == 200 and old.id == old_id
    assert old.category == "OWASP"
    award = await session.scalar(select(Solve).where(Solve.challenge_id == old.id))
    assert award.points_awarded == 150
    for puzzle in PUZZLES:
        solved = await client.post(
            "/api/challenges/submit", headers=headers, json={"flag": puzzle[3]}
        )
        assert solved.json()["correct"] and solved.json()["points_awarded"] == puzzle[4]
    assert not any(item["missing"] for item in await terminal_status(session, settings))
