import pytest
from sqlalchemy import func, select, text

from app.models import AuditLog, GroupChallengeCredit, PlayerScoreboard, Solve
from app.user_points import UserPointsImport, import_user_points
from tests.conftest import make_challenge, make_user, session_cookie
from tests.test_flag_admin import _member

ENDPOINT = "/api/admin/user-points/import"


async def setup_award(session, settings):
    operator = await _member(session)
    player = await make_user(session, username="demo-speaker", groups=["engineering"])
    player.full_name = "Demo Speaker"
    await session.commit()
    challenge = await make_challenge(
        session,
        settings,
        slug="talk-demo-day-2026-10-09",
        category="Talks",
        points=500,
    )
    return operator, player, challenge


async def test_preview_award_repeat_and_scoreboard(client, settings, session):
    operator, player, challenge = await setup_award(session, settings)
    headers = session_cookie(settings, operator)
    body = {"user": "Demo Speaker", "challenge": challenge.slug}
    preview = await client.post(ENDPOINT, headers=headers, json={**body, "preview": True})
    assert preview.status_code == 200
    assert preview.json()["points"] == 500
    assert preview.json()["points_awarded"] == 0
    assert await session.scalar(select(func.count(Solve.id))) == 0
    assert await session.scalar(select(func.count(AuditLog.id))) == 0
    for expected in (500, 0):
        response = await client.post(ENDPOINT, headers=headers, json=body)
        assert response.status_code == 200
        assert response.json()["points_awarded"] == expected
        assert response.json()["already_awarded"] == (expected == 0)
    score = await session.get(PlayerScoreboard, player.id)
    assert (score.score, score.solves, score.failed_attempts) == (500, 1, 0)
    audit = (await session.scalars(select(AuditLog))).one()
    assert audit.user_id == operator.id
    assert audit.detail["recipient_user_id"] == player.id
    assert "Demo Speaker" not in str(audit.detail)
    assert await session.scalar(select(func.count(GroupChallengeCredit.id))) == 0
    leaderboard = (await client.get("/api/leaderboard", headers=headers)).json()
    assert next(row for row in leaderboard if row["username"] == player.username)["score"] == 500
    # Ordinary flag submission cannot pay again after the administrator import.
    result = await client.post(
        "/api/challenges/submit",
        headers=session_cookie(settings, player),
        json={"flag": "xsecurity{hi}"},
    )
    assert result.json()["already_solved"] is True
    assert result.json()["points_awarded"] == 0


async def test_permissions_and_exact_identity(client, settings, session):
    operator, player, challenge = await setup_award(session, settings)
    body = {"user": player.username, "challenge": challenge.slug}
    assert (await client.post(ENDPOINT, json=body)).status_code == 401
    assert (
        await client.post(ENDPOINT, headers=session_cookie(settings, player), json=body)
    ).status_code == 403
    player.is_admin = True
    player.groups = ["funwithflags-admins"]  # Unverified claim, not a validated SAML administrator.
    await session.commit()
    assert (
        await client.post(ENDPOINT, headers=session_cookie(settings, player), json=body)
    ).status_code == 403
    headers = session_cookie(settings, operator)
    for changed, status in [
        ({"user": "Demo"}, 404),
        ({"challenge": "missing"}, 404),
        ({"points": 9000}, 422),
        ({"user": " "}, 422),
    ]:
        assert (
            await client.post(ENDPOINT, headers=headers, json={**body, **changed})
        ).status_code == status
    other = await make_user(session, username="second-speaker")
    other.full_name = player.full_name
    await session.commit()
    assert (
        await client.post(ENDPOINT, headers=headers, json={**body, "user": "Demo Speaker"})
    ).status_code == 409
    player.is_active = False
    await session.commit()
    assert (await client.post(ENDPOINT, headers=headers, json=body)).status_code == 409
    operator.groups = []
    await session.commit()
    assert (await client.post(ENDPOINT, headers=headers, json=body)).status_code == 403
    assert await session.scalar(select(func.count(Solve.id))) == 0


async def test_prior_solve_and_ineligible_challenge(client, settings, session):
    operator, player, challenge = await setup_award(session, settings)
    headers = session_cookie(settings, operator)
    body = {"user": player.username, "challenge": challenge.slug}
    challenge.is_active = False
    await session.commit()
    assert (await client.post(ENDPOINT, headers=headers, json=body)).status_code == 409
    challenge.is_active = True
    challenge.category = "misc"
    await session.commit()
    assert (await client.post(ENDPOINT, headers=headers, json=body)).status_code == 409
    challenge.category = "Talks"
    session.add(Solve(user_id=player.id, challenge_id=challenge.id, points_awarded=500))
    await session.commit()
    result = await client.post(ENDPOINT, headers=headers, json=body)
    assert result.json()["already_awarded"] is True
    assert result.json()["points_awarded"] == 0
    assert await session.scalar(select(func.count(AuditLog.id))) == 0


async def test_projection_failure_rolls_back_award_and_audit(monkeypatch, settings, session):
    operator, player, challenge = await setup_award(session, settings)

    async def fail(*args):
        raise RuntimeError("synthetic projection failure")

    monkeypatch.setattr("app.user_points.refresh_affected", fail)
    # SQLite needs an explicit outer write transaction before a SAVEPOINT.
    await session.execute(text("BEGIN"))
    with pytest.raises(RuntimeError, match="synthetic projection"):
        await import_user_points(
            session,
            operator.id,
            UserPointsImport(
                user=player.username,
                challenge=challenge.slug,
            ),
        )
    await session.rollback()
    assert await session.scalar(select(func.count(Solve.id))) == 0
    assert await session.scalar(select(func.count(AuditLog.id))) == 0
