from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app.config import Settings
from app.models import AuditLog, Solve
from app.scoreboard_projection import refresh_affected
from tests.conftest import make_challenge, make_user, session_cookie


def test_exclusion_configuration_accepts_csv(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "unit-test-session-secret-that-is-long-enough-000")
    monkeypatch.setenv("FLAG_HASH_SECRET", "unit-test-flag-hash-secret-that-is-long-enough-0")
    settings = Settings(scoreboard_excluded_subjects="subject:one, subject:two ")
    assert settings.scoreboard_excluded_subjects == ["subject:one", "subject:two"]
    assert "subject:one" not in repr(settings)


async def test_owner_exclusion_preserves_progress_and_other_admins(client, settings, session):
    owner = await make_user(session, username="operator", is_admin=True)
    participant = await make_user(session, username="participant", is_admin=True)
    owner.full_name = participant.full_name = "Same Display Name"
    yesterday = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
    owner.last_login_at = participant.last_login_at = yesterday
    challenge = await make_challenge(session, settings, category="gold", points=500)
    session.add_all([
        AuditLog(user_id=owner.id, event_type="saml.login", created_at=yesterday),
        AuditLog(user_id=participant.id, event_type="saml.login", created_at=yesterday),
        Solve(user_id=owner.id, challenge_id=challenge.id, points_awarded=500),
        Solve(user_id=participant.id, challenge_id=challenge.id, points_awarded=100),
    ])
    await session.flush()
    await refresh_affected(session, {owner.id, participant.id}, set())
    await session.commit()
    settings.scoreboard_excluded_subjects = [owner.okta_sub]
    headers = session_cookie(settings, participant)
    # Exclude before limiting, with no gaps in the visible rankings.
    ranking = (await client.get("/api/leaderboard?limit=1", headers=headers)).json()
    assert len(ranking) == 1
    assert ranking[0]["username"] == participant.username
    assert ranking[0]["rank"] == 1
    visible = (await client.get("/api/leaderboard/me", headers=headers)).json()
    assert visible["total_players"] == 1
    assert visible["entry"]["rank"] == 1
    private = (await client.get("/api/leaderboard/me", headers=session_cookie(settings, owner))).json()
    assert private["entry"]["rank"] is None
    assert private["entry"]["score"] == 500
    assert private["entry"]["solves"] == 1
    assert private["total_players"] == 1
    # Profile progress and administrator access are not revoked by an opt-out.
    profile = (await client.get("/api/auth/me", headers=session_cookie(settings, owner))).json()
    assert profile["score"] == 500
    assert profile["is_admin"] is True
    assert await session.scalar(select(func.count(Solve.id))) == 2
    stats = (await client.get("/api/admin/user-stats", headers=headers)).json()
    assert stats["people_with_points"] == 2
    assert stats["people_logged_in"] == 2
    assert stats["average_daily_logins"] == 0.07
    # Renaming the opted-out player cannot restore their competition row.
    owner.full_name = "Renamed Operator"
    owner.username = "renamed-operator"
    await session.commit()
    assert len((await client.get("/api/leaderboard", headers=headers)).json()) == 1
    # Reversible presentation policy: the earned records still exist.
    settings.scoreboard_excluded_subjects = []
    restored = (await client.get("/api/leaderboard", headers=headers)).json()
    assert [row["score"] for row in restored] == [500, 100]
