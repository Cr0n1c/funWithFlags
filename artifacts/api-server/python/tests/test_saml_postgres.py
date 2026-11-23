"""Opt-in development PostgreSQL verification, restricted to a disposable schema.

Run through validate_saml_postgres.py with an explicitly approved dedicated target.
"""

import asyncio
import os
import uuid
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import saml
from app.config import Settings
from app.db import Base, Database
from app.main import create_app
from app.models import SamlReplay, SamlTransaction, User
from tests.test_auth import CERT, assertion

pytestmark = pytest.mark.skipif(
    os.environ.get("SAML_TEST_POSTGRES") != "1",
    reason="explicit development DB opt-in required",
)


@pytest.fixture
async def isolated_postgres():
    if os.environ.get("SAML_TEST_POSTGRES_APPROVAL") != "dedicated-nonproduction":
        pytest.fail("Explicit approval of a dedicated non-production target is required")
    target = os.environ.get("SAML_TEST_POSTGRES_URL")
    if not target:
        pytest.fail("A dedicated PostgreSQL test target is required")
    settings = Settings(
        database_url=SecretStr(target),
        db_echo=False,
        app_base_url="https://ui.test",
        saml_sp_entity_id="https://ui.test/saml",
        saml_acs_url="https://ui.test/api/auth/saml/acs",
        saml_idp_entity_id="https://idp.test/entity",
        saml_idp_sso_url="https://idp.test/sso",
        saml_idp_cert=SecretStr(CERT),
        run_migrations_on_startup=False,
        seed_on_startup=False,
    )
    if settings.environment != "development":
        pytest.fail("PostgreSQL verification is permitted only in development")
    if not settings.sqlalchemy_url.startswith("postgresql+asyncpg://"):
        pytest.fail("PostgreSQL verification requires an asyncpg database")
    schema = "saml_test_" + uuid.uuid4().hex
    control = Database(settings)
    db = Database.__new__(Database)
    db.engine = create_async_engine(
        settings.sqlalchemy_url,
        hide_parameters=True,
        connect_args={"server_settings": {"search_path": schema}},
    )
    db.session_factory = async_sessionmaker(db.engine, expire_on_commit=False)
    created = False
    try:
        async with control.engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
        created = True
        async with db.engine.begin() as conn:
            assert await conn.scalar(text("SELECT current_schema()")) == schema
            await conn.run_sync(Base.metadata.create_all)
        app = create_app(settings, database=db)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://ui.test",
        ) as client:
            async with app.router.lifespan_context(app):
                yield settings, db, client
    finally:
        errors = []
        try:
            await db.dispose()
        except Exception:
            errors.append("test engine disposal")
        try:
            if created:
                async with control.engine.begin() as conn:
                    await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
                    remaining = await conn.scalar(
                        text("SELECT count(*) FROM pg_namespace WHERE nspname = :schema"),
                        {"schema": schema},
                    )
                    if remaining:
                        raise RuntimeError("schema still exists")
        except Exception:
            errors.append("disposable schema cleanup")
        try:
            await control.dispose()
        except Exception:
            errors.append("control engine disposal")
        if errors:
            pytest.fail("PostgreSQL teardown failed: " + ", ".join(errors), pytrace=False)


@pytest.mark.parametrize("case", ["jit", "transaction_replay", "assertion_replay"])
async def test_concurrent_saml_postgres(isolated_postgres, monkeypatch, case):
    settings, db, client = isolated_postgres

    async def flow():
        result = await client.get("/api/auth/login")
        assert result.status_code == 302
        relay = parse_qs(urlsplit(result.headers["location"]).query)["RelayState"][0]
        async with db.session_factory() as session:
            transaction = await session.get(SamlTransaction, saml.digest(relay))
            request_id = transaction.request_id
        return relay, request_id, result.cookies[settings.saml_transaction_cookie_name]

    first = await flow()
    second = first if case == "transaction_replay" else await flow()
    if case == "jit":
        # Force both separate transactions to observe the missing account before
        # either inserts it, exercising the unique-conflict savepoint recovery.
        barrier = asyncio.Barrier(2)
        original = AsyncSession.execute

        async def execute(session, statement, *args, **kwargs):
            result = await original(session, statement, *args, **kwargs)
            if getattr(statement, "_for_update_arg", None) is not None:
                # Only the first SELECT per session should wait; the recovery
                # SELECT must run after the winning transaction commits.
                if not session.info.get("jit_barrier"):
                    session.info["jit_barrier"] = True
                    await asyncio.wait_for(barrier.wait(), timeout=15)
            return result

        monkeypatch.setattr(AsyncSession, "execute", execute)

    async def finish(flow_data):
        relay, request_id, cookie = flow_data
        encoded = assertion(
            settings,
            request_id,
            aid="_shared" if case == "assertion_replay" else None,
        )
        return await client.post(
            "/api/auth/saml/acs",
            data={"SAMLResponse": encoded, "RelayState": relay},
            headers={"Cookie": f"{settings.saml_transaction_cookie_name}={cookie}"},
        )

    results = await asyncio.wait_for(
        asyncio.gather(finish(first), finish(second)),
        timeout=30,
    )
    successes = sum("auth=ok" in result.headers["location"] for result in results)
    assert successes == (2 if case == "jit" else 1)
    assert sum(settings.session_cookie_name in r.cookies for r in results) == successes
    async with db.session_factory() as session:
        assert await session.scalar(select(func.count()).select_from(User)) == 1
        assert await session.scalar(select(func.count()).select_from(SamlReplay)) == successes
        assert await session.scalar(select(func.count()).select_from(SamlTransaction)) == 0
