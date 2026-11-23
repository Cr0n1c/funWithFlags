"""The IdP-free sign-in must exist only for localhost development."""

import pytest
from pydantic import ValidationError

import run_server
from app import cli
from app.config import Settings
from app.routers import auth

BASE = {
    "SESSION_SECRET": "unit-test-session-secret-that-is-long-enough-000",
    "FLAG_HASH_SECRET": "unit-test-flag-hash-secret-that-is-long-enough-0",
    "SESSION_COOKIE_SECURE": "false",
    "LOCAL_DEV_LOGIN": "true",
}


LOCAL = {"Host": "localhost:5173"}


def configure(monkeypatch, **overrides):
    for key in ("NODE_ENV", "SAML_IDP_SSO_URL", "SAML_IDP_ENTITY_ID"):
        monkeypatch.delenv(key, raising=False)
    env = {
        **BASE,
        "ENVIRONMENT": "development",
        "APP_BASE_URL": "http://localhost:5173",
        **overrides,
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Settings()


def test_accepted_only_for_localhost_development(monkeypatch):
    assert configure(monkeypatch).local_dev_login is True
    assert configure(monkeypatch, APP_BASE_URL="http://127.0.0.1:5173").local_dev_login is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"ENVIRONMENT": "test"},
        {
            "ENVIRONMENT": "production",
            "APP_BASE_URL": "https://flags.example.test",
            "SESSION_COOKIE_SECURE": "true",
        },
        {"APP_BASE_URL": "https://flags.example.test"},
        {"APP_BASE_URL": "http://localhost.example.test"},
        {"SAML_IDP_SSO_URL": "https://idp.example.test/sso"},
        {"SAML_IDP_ENTITY_ID": "http://idp.example.test/issuer"},
    ],
)
def test_rejected_at_startup_everywhere_else(monkeypatch, overrides):
    with pytest.raises(ValidationError):
        configure(monkeypatch, **overrides)


async def test_disabled_by_default(client, settings):
    response = await client.get("/api/auth/login")
    assert response.status_code == 303
    assert "auth_error=" in response.headers["location"]
    assert settings.session_cookie_name not in response.cookies


async def test_signs_in_a_local_account(client, settings):
    settings.environment = "development"
    settings.local_dev_login = True
    response = await client.get("/api/auth/login", headers=LOCAL)
    assert response.headers["location"].endswith("?auth=ok")
    token = response.cookies[settings.session_cookie_name]
    me = await client.get(
        "/api/auth/me",
        headers={
            "Cookie": f"{settings.session_cookie_name}={token}",
        },
    )
    assert me.status_code == 200
    assert me.json()["email"] == "dev@localhost"
    assert me.json()["is_admin"] is True


@pytest.mark.parametrize("change", ["mode", "saml", "remote"])
async def test_handler_refuses_outside_local_development(client, settings, monkeypatch, change):
    settings.environment = "development"
    settings.local_dev_login = True
    if change == "mode":
        settings.environment = "test"
    elif change == "saml":
        settings.saml_idp_sso_url = "https://idp.example.test/sso"
    else:
        monkeypatch.setattr(auth, "LOCAL_HOSTS", frozenset())
    response = await client.get("/api/auth/login", headers=LOCAL)
    assert "auth_error=" in response.headers["location"]
    assert settings.session_cookie_name not in response.cookies


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "rebind.attacker.test"},
        {"Host": "localhost.attacker.test:8000"},
        {},  # The fixture's own non-local host.
        {**LOCAL, "X-Forwarded-For": "127.0.0.1"},
        {**LOCAL, "Forwarded": "for=127.0.0.1"},
        {**LOCAL, "X-Real-IP": "127.0.0.1"},
        {**LOCAL, "X-Forwarded-Host": "localhost"},
    ],
)
async def test_handler_refuses_foreign_hosts_and_forwarded_peers(client, settings, headers):
    settings.environment = "development"
    settings.local_dev_login = True
    response = await client.get("/api/auth/login", headers=headers)
    assert "auth_error=" in response.headers["location"]
    assert settings.session_cookie_name not in response.cookies


@pytest.mark.parametrize("enabled", [True, False])
def test_servers_listen_on_loopback_without_proxy_headers(monkeypatch, enabled):
    settings = configure(monkeypatch, LOCAL_DEV_LOGIN=str(enabled).lower(), PORT="8123")
    seen = []
    for module in (cli, run_server):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
        monkeypatch.setattr(module.uvicorn, "run", lambda app, **kwargs: seen.append(kwargs))
    monkeypatch.setattr(run_server, "configure_environment", lambda: None)
    monkeypatch.setattr(run_server, "configure_logging", lambda settings: None)
    cli._serve()
    run_server.main()
    assert len(seen) == 2
    for kwargs in seen:
        assert (kwargs["host"] == "127.0.0.1") is enabled
        assert kwargs["proxy_headers"] is not enabled
