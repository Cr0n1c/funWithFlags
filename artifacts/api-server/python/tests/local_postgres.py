"""Disposable PostgreSQL for concurrency tests; never accepts an external URL."""

import os
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def postgres_url():
    with local_postgres() as url:
        yield url


@contextmanager
def local_postgres():
    tools = {name: shutil.which(name) for name in ("initdb", "pg_ctl", "psql")}
    if not all(tools.values()):
        message = "PostgreSQL concurrency tests require local initdb, pg_ctl and psql"
        if os.environ.get("REQUIRE_LOCAL_POSTGRES") == "1":
            pytest.fail(message, pytrace=False)
        pytest.skip(message)
    # Short socket path, private parent directory, and no TCP listener. Ambient
    # PG* settings and application credentials are deliberately not inherited.
    with tempfile.TemporaryDirectory(prefix="fwf-pg-") as directory:
        root = Path(directory)
        socket = root / "socket"
        socket.mkdir(mode=0o700)
        data = root / "data"
        # A fixed C locale: macOS postmaster refuses to start without a valid one.
        env = {"PATH": str(Path(tools["initdb"]).parent), "HOME": directory, "LC_ALL": "C"}

        def run(tool, *args):
            return subprocess.run(
                [tools[tool], *args], env=env, check=True,
                capture_output=True, text=True, timeout=30,
            )

        # This fresh cluster is discarded after every invocation. Avoid the
        # initial empty-cluster disk flush, which can exceed the setup deadline
        # on shared storage. PostgreSQL's runtime fsync/full_page_writes and
        # synchronous_commit defaults remain enabled for all actual test data.
        run("initdb", "-D", str(data), "-U", "fwf_test_admin",
            "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8",
            "--no-sync")
        try:
            run("pg_ctl", "-D", str(data), "-l", str(root / "server.log"), "-w",
                "-o", f"-c listen_addresses='' -c unix_socket_directories='{socket}' "
                "-c unix_socket_permissions=0700", "start")
            for statement in (
                "CREATE ROLE fwf_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE",
                "CREATE DATABASE fwf_test OWNER fwf_test",
            ):
                run("psql", "-X", "-w", "-h", str(socket), "-U", "fwf_test_admin",
                    "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", statement)
            yield f"postgresql+asyncpg://fwf_test@/fwf_test?host={socket}"
        finally:
            if (data / "postmaster.pid").exists():
                run("pg_ctl", "-D", str(data), "-m", "immediate", "-w", "stop")