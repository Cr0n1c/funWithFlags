"""Sanitized startup contracts; no network, live trust material, or database."""
import os

import pytest
from pydantic import ValidationError

import run_server
from app.config import Settings, get_settings


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for key in list(os.environ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SESSION_SECRET", "synthetic-session-secret-000000000000")
    monkeypatch.setenv("FLAG_HASH_SECRET", "synthetic-flag-secret-000000000000000")
    monkeypatch.setenv("APP_BASE_URL", "https://public.example.test")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.mark.parametrize(("signals", "expected"), [
    ({}, "development"),
    ({"ENVIRONMENT": "development"}, "development"),
    ({"ENVIRONMENT": "production"}, "production"),
    ({"ENVIRONMENT": "test"}, "test"),
    ({"NODE_ENV": "production"}, "production"),
    ({"NODE_ENV": "test"}, "test"),
    ({"ENVIRONMENT": "production", "NODE_ENV": "production"}, "production"),
])
def test_all_startups_resolve_same_mode(monkeypatch, signals, expected):
    for key, value in signals.items():
        monkeypatch.setenv(key, value)
    assert Settings().environment == expected
    assert get_settings().environment == expected
    run_server.configure_environment()
    assert os.environ["ENVIRONMENT"] == expected
    assert Settings().environment == expected
    assert os.environ["SESSION_COOKIE_SECURE"] == "true"
    assert os.environ["RUN_MIGRATIONS_ON_STARTUP"] == "false"
    assert os.environ["SEED_ON_STARTUP"] == "false"


@pytest.mark.parametrize("signals", [
    {"ENVIRONMENT": "development", "NODE_ENV": "production"},
    {"ENVIRONMENT": "production", "NODE_ENV": "development"},
    {"ENVIRONMENT": "unknown-sensitive-value"},
    {"ENVIRONMENT": ""},
    {"NODE_ENV": "unknown-sensitive-value"},
])
def test_conflicts_fail_before_launch_without_values(monkeypatch, signals):
    for key, value in signals.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(ValidationError) as settings_error:
        Settings()
    with pytest.raises(SystemExit) as launcher_error:
        run_server.configure_environment()
    assert "unknown-sensitive-value" not in str(settings_error.value)
    assert "unknown-sensitive-value" not in str(launcher_error.value)


@pytest.mark.parametrize("origin", [
    "http://public.example.test", "https://localhost",
    "https://APP.LOCALHOST.",
    "https://127.0.0.1", "https://[::1]", "https://user:password@example.test",
    "https://example.test/path", "https://example.test?query=1",
    "https://example.test#fragment", "https://example.test:invalid",
    "https://[broken",
    "https://127.1.2.3", "https://[::ffff:127.0.0.1]", "https://10.0.0.1",
    "https://example.test\n", "https://example.test\\other",
])
def test_production_origin_rejected_in_every_startup(monkeypatch, origin):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("APP_BASE_URL", origin)
    with pytest.raises(ValidationError):
        Settings()
    with pytest.raises(SystemExit):
        run_server.configure_environment()


@pytest.mark.parametrize("mode", ["development", "test", "production"])
def test_launcher_requires_configured_origin(monkeypatch, mode):
    monkeypatch.setenv("ENVIRONMENT", mode)
    monkeypatch.delenv("APP_BASE_URL")
    with pytest.raises(SystemExit):
        run_server.configure_environment()
    assert "APP_BASE_URL" not in os.environ


def test_standalone_local_test_behavior(monkeypatch):
    monkeypatch.delenv("APP_BASE_URL")
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "false")
    assert Settings().app_base_url == "http://localhost:8080"
    assert not Settings().session_cookie_secure


def test_launcher_passes_resolved_settings_without_running_server(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("PORT", "8123")
    seen = {}
    monkeypatch.setattr(run_server, "configure_logging",
                        lambda settings: seen.update(mode=settings.environment))
    monkeypatch.setattr(run_server.uvicorn, "run",
                        lambda app, **kwargs: seen.update(app=app, **kwargs))
    run_server.main()
    assert seen["mode"] == "production"
    assert seen["app"] == "app.asgi:app"
    assert seen["port"] == 8123