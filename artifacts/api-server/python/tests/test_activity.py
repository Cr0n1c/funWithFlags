"""Offline activity contracts. No Slack hostname is contacted by these tests."""

import socket
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select, text

from app import activity
from app.config import Settings
from app.main import create_app
from app.models import ActivityOutbox
from app.routers import activity as activity_router
from tests.conftest import make_challenge, make_user, session_cookie
from tests.test_auth import CERT, finish, start

WEBHOOK = "https://hooks.slack.com/services/TEST/EXAMPLE/ONLY"


@pytest.fixture
def saml_settings(settings):
    settings.app_base_url = "https://ui.test"
    settings.saml_sp_entity_id = "https://ui.test/saml"
    settings.saml_acs_url = "https://ui.test/api/auth/saml/acs"
    settings.saml_idp_entity_id = "https://idp.test/entity"
    settings.saml_idp_sso_url = "https://idp.test/sso"
    settings.saml_idp_cert = SecretStr(CERT)
    return settings


def enabled(settings, monkeypatch):
    settings.slack_activity_enabled = True
    settings.slack_activity_webhook_url = SecretStr(WEBHOOK)
    send = AsyncMock(return_value=True)
    monkeypatch.setattr(activity, "_post", send)
    monkeypatch.setattr(activity_router, "_post", send)
    return send


def test_url_guard_and_message_escape(settings):
    assert activity.webhook_url(settings) is None
    settings.slack_activity_enabled = True
    for url in (
        "http://hooks.slack.com/services/A/B/C",
        "https://hooks.slack.com.evil.test/services/A/B/C",
        "https://hooks.slack.com:444/services/A/B/C",
        "https://hooks.slack.com/services/A/B/C?secret=1",
        "https://hooks.slack.com/services/A/B/C/extra",
        "https://hooks.slack.com@evil.test/services/A/B/C",
    ):
        settings.slack_activity_webhook_url = SecretStr(url)
        assert activity.webhook_url(settings) is None
    settings.slack_activity_webhook_url = SecretStr(WEBHOOK)
    assert WEBHOOK not in repr(settings)
    assert activity.webhook_url(settings) == WEBHOOK
    assert activity.safe_text("<@U1>\n&@channel") == "&lt;\uff20U1&gt; &amp;\uff20channel"


@pytest.mark.asyncio
async def test_slack_wire_payload_is_plain_and_never_redirects(monkeypatch):
    captured = {}

    class OfflineClient:
        def __init__(self, **options):
            captured["options"] = options

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def post(self, url, *, json):
            captured["url"] = url
            captured["json"] = json
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(activity.httpx, "AsyncClient", OfflineClient)
    message = "player earned 2 points by completing &lt;challenge&gt;."
    assert await activity._post(WEBHOOK, message)
    assert captured["options"]["follow_redirects"] is False
    assert captured["options"]["trust_env"] is False
    assert captured["json"]["blocks"][0]["text"] == {
        "type": "plain_text",
        "text": message,
        "emoji": False,
    }
    assert captured["json"]["unfurl_links"] is False
    assert captured["json"]["text"] == message


@pytest.mark.asyncio
async def test_scoring_committed_once_and_hidden_title_not_sent(
    client,
    settings,
    session,
    monkeypatch,
):
    send = enabled(settings, monkeypatch)
    user = await make_user(session, username="private-email")
    user.shell_name = "player-one"
    await session.commit()
    challenge = await make_challenge(
        session,
        settings,
        slug="private-title",
        flag="SECRET{value}",
        points=19,
        hidden=True,
    )
    challenge.title = "SECRET planted answer"
    await session.commit()
    await session.refresh(user)
    headers = session_cookie(settings, user)
    path = "/api/challenges/private-title/submit"
    assert (await client.post(path, json={"flag": "wrong"}, headers=headers)).status_code == 200
    assert send.await_count == 0
    first = await client.post(path, json={"flag": "SECRET{value}"}, headers=headers)
    assert first.json()["points_awarded"] == 19
    assert send.await_args.args[1] == "player-one earned 19 points by completing challenge."
    assert (await client.post(path, json={"flag": "SECRET{value}"}, headers=headers)).json()[
        "already_solved"
    ]
    assert send.await_count == 1
    rows = (await session.execute(select(ActivityOutbox))).scalars().all()
    assert len(rows) == 1 and rows[0].delivered_at is not None


@pytest.mark.asyncio
async def test_command_only_authenticated_allowlisted_and_throttled(
    client,
    settings,
    session,
    monkeypatch,
):
    send = enabled(settings, monkeypatch)
    user = await make_user(session)
    user.shell_name = "player-two"
    await session.commit()
    await session.refresh(user)
    url = "/api/activity/command"
    headers = {**session_cookie(settings, user), "Origin": settings.app_base_url}
    assert (
        await client.post(
            url,
            json={"command": "scoreboard"},
            headers=headers,
        )
    ).status_code == 204
    assert send.await_args.args[1] == "player-two ran scoreboard."
    for payload in (
        {"command": "scoreboard", "username": "forged"},
        {"command": "<@U123>"},
        {"command": "cat SECRET"},
        {"points": 100, "title": "forged"},
    ):
        assert (await client.post(url, json=payload, headers=headers)).status_code == 422
    assert (await client.post(url, json={"command": "scoreboard"})).status_code == 401
    assert (
        await client.post(
            url,
            json={"command": "scoreboard"},
            headers={
                **session_cookie(settings, user),
                "Origin": "https://evil.test",
            },
        )
    ).status_code == 403
    for _ in range(15):
        assert (
            await client.post(url, json={"command": "shell command"}, headers=headers)
        ).status_code == 204
    assert send.await_count == 10


@pytest.mark.asyncio
@pytest.mark.parametrize("opt_in", [True, False])
async def test_verified_login_once_not_profile_refresh(
    client,
    saml_settings,
    session,
    monkeypatch,
    opt_in,
):
    configured = saml_settings
    send = enabled(configured, monkeypatch)
    configured.slack_activity_enabled = opt_in
    flow = await start(client, configured, session, popup=False)
    response = await finish(client, configured, flow)
    assert response.status_code == 303
    assert send.await_count == int(opt_in)
    if opt_in:
        assert send.await_args.args[1].endswith(" logged into Fun With Flags.")
        assert "alice@example.test" not in send.await_args.args[1]
    token = response.cookies[configured.session_cookie_name]
    await client.get(
        "/api/auth/me",
        headers={
            "Cookie": f"{configured.session_cookie_name}={token}",
        },
    )
    assert send.await_count == int(opt_in)
    assert (await finish(client, configured, flow)).status_code == 303
    assert send.await_count == int(opt_in)


@pytest.mark.asyncio
async def test_delivery_retry_after_commit_and_missing_schema_fail_open(
    client,
    settings,
    session,
    database,
    monkeypatch,
):
    send = enabled(settings, monkeypatch)
    send.return_value = False
    user = await make_user(session)
    await make_challenge(session, settings, flag="real-flag", points=9)
    response = await client.post(
        "/api/challenges/warmup/submit",
        json={"flag": "real-flag"},
        headers=session_cookie(settings, user),
    )
    assert response.json()["points_awarded"] == 9
    row = (await session.execute(select(ActivityOutbox))).scalar_one()
    assert row.attempts == 1 and row.delivered_at is None
    await activity.drain(session, settings)
    assert send.await_count == 1  # Exponential backoff, no immediate retry.
    row.next_attempt_at = datetime(2020, 1, 1, tzinfo=UTC)
    await session.commit()
    send.return_value = True
    await activity.drain(session, settings)
    await session.refresh(row)
    assert row.delivered_at is not None and send.await_count == 2

    async with database.engine.begin() as conn:
        await conn.execute(text("DROP TABLE activity_outbox"))
    other = await make_challenge(session, settings, slug="second", flag="another")
    assert other.id
    result = await client.post(
        "/api/challenges/second/submit",
        json={"flag": "another"},
        headers=session_cookie(settings, user),
    )
    assert result.status_code == 200 and result.json()["points_awarded"] > 0
    assert send.await_count == 2


@pytest.mark.asyncio
async def test_startup_never_sends_even_with_fake_webhook(settings, database, monkeypatch):
    monkeypatch.setenv("SLACK_ACTIVITY_WEBHOOK_URL", WEBHOOK)
    settings = Settings()

    def no_network(*args, **kwargs):
        raise AssertionError("startup must not make Slack network requests")

    monkeypatch.setattr(httpx.AsyncClient, "post", no_network)
    monkeypatch.setattr(socket.socket, "connect", no_network)
    app = create_app(settings, database=database)
    async with app.router.lifespan_context(app):
        async with database.session_factory() as db:
            assert (await db.execute(select(ActivityOutbox))).scalars().all() == []
