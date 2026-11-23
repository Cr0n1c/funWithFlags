"""FastAPI application factory."""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import migrations
from app.config import Settings, get_settings
from app.crack_hashes import normalize_hash_categories
from app.db import Database
from app.logging import configure_logging, get_logger
from app.routers import activity, admin, auth, challenges, flag_admin, health, leaderboard
from app.routers import command_catalog
from app.routers import training
from app.routers import public_curl
from app.scoreboard_projection import initialize_missing
from app.seed import load_seed_file, upsert_challenges

API_PREFIX = "/api"
log = get_logger(__name__)


def create_app(
    settings: Settings | None = None,
    *,
    database: Database | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.db = database or Database(settings)
        if settings.run_migrations_on_startup:
            await migrations.upgrade_head(settings)
        if settings.seed_on_startup and settings.challenges_file:
            async with app.state.db.session_factory() as session:
                await upsert_challenges(session, settings, load_seed_file(settings.challenges_file))
        # A deployment may apply schema without data backfills. Normalize only
        # verified legacy rows in a normal transaction before serving requests.
        async with app.state.db.session_factory() as session:
            reclassified = await normalize_hash_categories(session)
        if reclassified:
            log.info("crack_hashes.reclassified", count=reclassified)
        # A deployment can create the tables without backfilling awards.
        # Only absent keys are reconciled; existing projection snapshots remain
        # owned by the transactionally locked award/attempt write paths.
        async with app.state.db.session_factory() as session:
            initialized = await initialize_missing(session)
            await session.commit()
        if any(initialized):
            log.info("scoreboard.initialized", players=initialized[0], groups=initialized[1])
        log.info("app.started", environment=settings.environment)
        try:
            yield
        finally:
            await app.state.db.dispose()

    app = FastAPI(
        title="Fun With Flags API",
        version="2.0.0",
        lifespan=lifespan,
        docs_url=None if settings.is_production else f"{API_PREFIX}/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else f"{API_PREFIX}/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(RequestValidationError)
    async def validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        if request.url.path == "/api/flag-admin/import-challenges":
            # Unknown JSON keys may be attacker-controlled secrets too (the
            # default Pydantic location can reflect them even without input).
            return JSONResponse(
                {"detail": "Invalid challenge import request"}, status_code=422
            )
        # Pydantic's default response includes the rejected input. Flag plaintext
        # must never be reflected in validation output.
        errors = [
            {key: value for key, value in error.items() if key not in {"input", "ctx"}}
            for error in exc.errors()
        ]
        return JSONResponse({"detail": errors}, status_code=422)

    @app.middleware("http")
    async def request_logging(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            log.exception("http.unhandled", method=request.method, path=request.url.path)
            response = JSONResponse({"detail": "Internal server error"}, status_code=500)
        response.headers["X-Request-ID"] = request_id
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.url.path != f"{API_PREFIX}/health":
            log.info(
                "http.request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=round((time.perf_counter() - started) * 1000, 1),
            )
        return response

    for router in (
        activity.router,
        health.router,
        auth.router,
        challenges.router,
        leaderboard.router,
        admin.router,
        flag_admin.router,
        command_catalog.router,
        training.router,
        public_curl.router,
    ):
        app.include_router(router, prefix=API_PREFIX)

    return app
