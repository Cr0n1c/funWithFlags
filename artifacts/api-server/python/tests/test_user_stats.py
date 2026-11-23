from datetime import UTC, datetime, timedelta

from app.models import AuditLog, PlayerScoreboard
from tests.conftest import make_user, session_cookie
from tests.test_flag_admin import _member


async def test_stats_permissions(client, settings, session):
    assert (await client.get("/api/admin/user-stats")).status_code == 401
    ordinary = await make_user(session)
    headers = session_cookie(settings, ordinary)
    assert (await client.get("/api/admin/user-stats", headers=headers)).status_code == 403
    # Unverified group claims do not confer administrator access.
    ordinary.groups = ["funwithflags-admins"]
    await session.commit()
    assert (await client.get("/api/admin/user-stats", headers=headers)).status_code == 403
    ordinary.is_admin = True
    await session.commit()
    assert (await client.get("/api/admin/user-stats", headers=headers)).status_code == 200


async def test_stats_zero_activity(client, settings, session):
    admin = await make_user(session, is_admin=True)
    data = (
        await client.get("/api/admin/user-stats", headers=session_cookie(settings, admin))
    ).json()
    assert data["people_logged_in"] == 0
    assert data["people_with_points"] == 0
    assert data["average_daily_logins"] == 0
    assert data["window_days"] == 30
    assert data["timezone"] == "UTC"


async def test_stats_unique_days_boundaries_and_positive_scores(client, settings, session):
    admin = await _member(session)
    person = await make_user(session, username="stats-person")
    never_logged_in = await make_user(session, username="stats-never")
    end = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=30)
    person.last_login_at = end
    session.add_all(
        [
            PlayerScoreboard(user_id=person.id, score=25, solves=1, failed_attempts=0),
            PlayerScoreboard(user_id=never_logged_in.id, score=0, solves=1, failed_attempts=0),
        ]
    )
    for user_id, when, kind in [
        (person.id, start, "saml.login"),
        (person.id, start + timedelta(hours=1), "saml.login"),  # Deduplicated.
        (admin.id, start, "saml.login"),
        (person.id, end - timedelta(days=1), "saml.login"),
        (person.id, end, "saml.login"),  # Today excluded.
        (person.id, start - timedelta(seconds=1), "saml.login"),
        (never_logged_in.id, start, "command"),
    ]:
        session.add(AuditLog(user_id=user_id, event_type=kind, created_at=when))
    await session.commit()
    response = await client.get("/api/admin/user-stats", headers=session_cookie(settings, admin))
    assert response.status_code == 200
    data = response.json()
    assert data["people_logged_in"] == 2
    assert data["people_with_points"] == 1
    assert data["average_daily_logins"] == 0.1  # Three user-days / 30, including empty days.
    assert data["window_start"] == start.date().isoformat()
    assert data["window_end"] == (end - timedelta(days=1)).date().isoformat()
    # Group access is evaluated on every request, not cached by the command.
    admin.groups = []
    await session.commit()
    assert (
        await client.get("/api/admin/user-stats", headers=session_cookie(settings, admin))
    ).status_code == 403
