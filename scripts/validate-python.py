"""No-credentials, no-network compilation, ASGI smoke, and curl release checks.

Never run migrations, seed, or authenticate here. This is not a
database/readiness or real SAML integration check. --setup-only omits the curl
suite; --curl runs only that bounded suite with disposable in-memory SQLite.
"""

from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "artifacts/api-server/python"


def startup() -> None:
    # Clear rather than blacklist: future credentials must not leak into settings.
    os.environ.clear()
    os.environ.update({
        "ENVIRONMENT": "production",
        "APP_BASE_URL": "https://validation.example.com",
        "SESSION_SECRET": "synthetic-merge-session-secret-0000000000",
        "FLAG_HASH_SECRET": "synthetic-merge-flag-secret-000000000000",
        "DATABASE_URL": "postgresql+asyncpg://synthetic:synthetic@db.invalid/unused",
        "RUN_MIGRATIONS_ON_STARTUP": "false",
        "SEED_ON_STARTUP": "false",
        "LOG_LEVEL": "WARNING",
    })
    # The parent may carry a managed webhook; the isolated child must never
    # inherit it, even if a future startup path accidentally attempts delivery.
    assert "SLACK_ACTIVITY_WEBHOOK_URL" not in os.environ
    violations: list[str] = []

    def deny_external(event: str, args: tuple) -> None:
        del args  # Do not reflect configuration or network targets in diagnostics.
        if event in {
            "socket.connect", "socket.bind", "socket.getaddrinfo",
            "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto",
            "subprocess.Popen", "os.system", "os.posix_spawn", "os.fork",
        }:
            violations.append(event)
            raise RuntimeError(f"Isolated startup forbids external operations: {event}")

    sys.addaudithook(deny_external)
    sys.path.insert(0, str(API))

    import asyncio
    from unittest.mock import patch

    import httpx
    from sqlalchemy.ext.asyncio import AsyncSession
    import run_server
    from app import main
    from app.db import Database

    def forbidden(*args, **kwargs):
        del args, kwargs
        violations.append("migration-or-seed")
        raise RuntimeError("Isolated startup forbids migrations and seed operations")

    # Exercise launcher's configuration validation without starting a server.
    run_server.configure_environment()
    from app.asgi import app

    async def check() -> None:
        disposed = False
        normalized = 0
        initialized = 0
        projection_commits = 0
        projection_session = None
        original_dispose = Database.dispose

        async def dispose(database):
            nonlocal disposed
            await original_dispose(database)
            disposed = True

        async def normalize(session):
            nonlocal normalized
            assert isinstance(session, AsyncSession), "Normalization did not receive a session"
            normalized += 1
            # The real normalization performs an UPDATE and commit. The smoke
            # check exercises the call site, not a database or production data.
            return 0

        async def initialize(session):
            nonlocal initialized, projection_session
            assert isinstance(session, AsyncSession), "Initializer did not receive a session"
            assert projection_session is None, "Initializer invoked more than once"
            projection_session = session
            initialized += 1
            # The real initializer queries award ledgers. Only this specific
            # call is simulated; any direct SQL still hits the deny guard.
            return (0, 0)

        async def forbid_db_call(*args, **kwargs):
            del args, kwargs
            violations.append("database-execute-or-commit")
            raise RuntimeError("Isolated startup forbids database queries and commits")

        async def commit_projection(session):
            nonlocal projection_commits
            if session is not projection_session or projection_commits:
                await forbid_db_call()
            projection_commits += 1
            # Do not connect: only the initializer's scoped session can commit
            # its simulated no-op work in this isolated smoke check.

        # Keep the real database constructor and teardown.
        # A future direct SQL call still fails before reaching any database.
        with (
            patch.object(Database, "dispose", dispose),
            patch.object(main, "normalize_hash_categories", normalize),
            patch.object(main, "initialize_missing", initialize),
            patch.object(AsyncSession, "execute", forbid_db_call),
            patch.object(AsyncSession, "commit", commit_projection),
            patch.object(main.migrations, "upgrade_head", forbidden),
            patch.object(main, "load_seed_file", forbidden),
            patch.object(main, "upsert_challenges", forbidden),
        ):
            async with app.router.lifespan_context(app):
                settings = app.state.settings
                assert settings.is_production
                assert not settings.run_migrations_on_startup
                assert not settings.seed_on_startup
                assert not settings.slack_activity_webhook_url.get_secret_value()
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app),
                    base_url="https://validation.example.com",
                    trust_env=False,
                ) as client:
                    response = await client.get("/api/health")
                    assert response.status_code == 200, "Liveness request failed"
                    assert response.json() == {"status": "ok"}
            assert normalized == 1, f"Startup normalization invoked {normalized} times, expected once"
            assert initialized == 1, f"Startup initializer invoked {initialized} times, expected once"
            assert projection_commits == 1, (
                f"Startup projection session committed {projection_commits} times, expected once"
            )
            assert disposed, "Lifespan teardown did not complete"
        assert not violations, f"Blocked operations were attempted: {violations}"

    asyncio.run(check())
    print("[merged-code] isolated ASGI import/startup/liveness/shutdown PASS", flush=True)


def curl_checks(timeout=180) -> int:
    """Bound the suite AND descendants, even if teardown hangs or TERM arrives."""
    with tempfile.TemporaryDirectory(prefix="curl-release-") as directory:
        process = None

        def interrupted(signum, frame):
            raise SystemExit(128 + signum)

        previous = signal.signal(signal.SIGTERM, interrupted)
        try:
            print("[merged-code] Python offline curl safety regressions", flush=True)
            process = subprocess.Popen(
                [sys.executable, "-B", str(ROOT / "scripts/validate-public-curl.py"),
                 "--suite", directory],
                cwd=ROOT, env={}, start_new_session=True,
            )
            try:
                status = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                print("[merged-code] FAIL: offline curl safety regressions timed out",
                      file=sys.stderr)
                return 1
            if status:
                print("[merged-code] FAIL: offline curl safety regressions", file=sys.stderr)
                return 1
            return 0
        except OSError:
            print("[merged-code] FAIL: cannot launch offline curl checks", file=sys.stderr)
            return 1
        finally:
            if process is not None:
                # Kill any abandoned grandchildren even when pytest exited.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            signal.signal(signal.SIGTERM, previous)


def main(*, setup_only=False) -> int:
    # Children inherit no environment secrets. The executable is absolute so
    # PATH is unnecessary; installed interpreter packages remain available.
    for label, command in (
        ("compileall", [sys.executable, "-m", "compileall", "-q", "-f", str(API)]),
        ("isolated startup", [sys.executable, "-B", str(Path(__file__).resolve()), "--startup"]),
    ):
        print(f"[merged-code] Python {label}", flush=True)
        try:
            result = subprocess.run(command, cwd=ROOT, env={}, timeout=30, check=False)
        except subprocess.TimeoutExpired:
            print(f"[merged-code] FAIL: {label} timed out", file=sys.stderr)
            return 1
        if result.returncode:
            print(f"[merged-code] FAIL: {label}", file=sys.stderr)
            return 1
    return 0 if setup_only else curl_checks()


if __name__ == "__main__":
    if sys.argv[1:] == ["--startup"]:
        startup()
    elif sys.argv[1:] == ["--curl"]:
        raise SystemExit(curl_checks())
    elif sys.argv[1:] == ["--setup-only"]:
        raise SystemExit(main(setup_only=True))
    elif sys.argv[1:]:
        raise SystemExit("Usage: validate-python.py [--setup-only|--curl]")
    else:
        raise SystemExit(main())