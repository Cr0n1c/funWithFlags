from __future__ import annotations

import os
from collections.abc import AsyncIterator

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import Settings
from app.db import Base, Database
from app.main import create_app
from app.models import Challenge, User
from app.security import encode_session, hash_flag


@pytest.fixture(autouse=True)
def disable_slack_activity(monkeypatch: pytest.MonkeyPatch) -> None:
    # Notification tests explicitly inject a fake destination and HTTP transport.
    monkeypatch.setenv("SLACK_ACTIVITY_WEBHOOK_URL", "")


TEST_ENV = {
    "ENVIRONMENT": "test",
    "LOG_JSON": "false",
    "LOG_LEVEL": "WARNING",
    "APP_BASE_URL": "http://ui.test",
    "SESSION_SECRET": "unit-test-session-secret-that-is-long-enough-000",
    "SESSION_COOKIE_SECURE": "false",
    "FLAG_HASH_SECRET": "unit-test-flag-hash-secret-that-is-long-enough-0",
    "SUBMIT_RATE_LIMIT_PER_MINUTE": "5",
}


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    for key in ("NODE_ENV",):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("SLACK_ACTIVITY_WEBHOOK_URL", raising=False)
    for key, value in TEST_ENV.items():
        monkeypatch.setenv(key, value)
    for key in list(os.environ):
        if key.startswith(("DB_", "DATABASE_URL", "SAML_")):
            monkeypatch.delenv(key, raising=False)
    return Settings()


@pytest.fixture
async def database(settings: Settings) -> AsyncIterator[Database]:
    db = Database.__new__(Database)
    db.engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    db.session_factory = async_sessionmaker(db.engine, expire_on_commit=False)
    async with db.engine.begin() as conn:
        await conn.execute(text("PRAGMA foreign_keys=ON"))
        await conn.run_sync(Base.metadata.create_all)
    yield db
    await db.dispose()


@pytest.fixture
async def client(settings: Settings, database: Database) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(settings, database=database)
    async with (
        httpx.ASGITransport(app=app) as transport,
        httpx.AsyncClient(transport=transport, base_url="http://ui.test") as c,
    ):
        async with app.router.lifespan_context(app):
            yield c


@pytest.fixture
async def session(database: Database) -> AsyncIterator[AsyncSession]:
    async with database.session_factory() as s:
        yield s


async def make_user(
    session: AsyncSession, *, username: str = "alice", is_admin: bool = False, groups=None
) -> User:
    user = User(
        okta_sub=f"legacy:sub-{username}",
        username=username,
        email=f"{username}@example.com",
        full_name=username.title(),
        groups=groups or [],
        is_admin=is_admin,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


async def make_challenge(
    session: AsyncSession,
    settings: Settings,
    *,
    slug: str = "warmup",
    flag: str = "xsecurity{hi}",
    points: int = 100,
    **kw,
) -> Challenge:
    case_sensitive = kw.pop("case_sensitive", False)
    ch = Challenge(
        slug=slug,
        title=slug.title(),
        category=kw.pop("category", "warmup"),
        description="desc",
        points=points,
        flag_hash=hash_flag(settings, flag, case_sensitive=case_sensitive),
        case_sensitive=case_sensitive,
        **kw,
    )
    session.add(ch)
    await session.commit()
    await session.refresh(ch)
    return ch


def session_cookie(settings: Settings, user: User) -> dict[str, str]:
    """Headers carrying a signed session cookie for ``user``."""
    return {"Cookie": f"{settings.session_cookie_name}={encode_session(settings, user)}"}
