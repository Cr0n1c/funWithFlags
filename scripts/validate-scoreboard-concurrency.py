"""Strict, local-only release evidence for scoreboard concurrency.

No target URL or pytest arguments are accepted. PostgreSQL is supplied by the
workspace's declared Nix PostgreSQL package, not an application database.
"""

import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "artifacts/api-server/python"
TOOLS = ("initdb", "pg_ctl", "psql")
EXPECTED = {
    "tests/test_scoreboard_projection.py::test_postgres_initialization_overlapping_writes[writer-first]",
    "tests/test_scoreboard_projection.py::test_postgres_initialization_overlapping_writes[initializer-first]",
    "tests/test_scoreboard_projection.py::test_postgres_initialization_overlapping_writes[group-first]",
    "tests/test_scoreboard_projection.py::test_postgres_simultaneous_initializers",
    *(
        "tests/test_scoreboard_projection.py::"
        f"test_postgres_flushed_initializer_cancellation[{state}]"
        for state in ("empty", "partial")
    ),
    *(
        "tests/test_scoreboard_projection.py::"
        f"test_postgres_partially_locked_initializer_cancellation[{state}]"
        for state in ("empty", "partial")
    ),
    *(
        "tests/test_scoreboard_projection.py::"
        f"test_postgres_initialization_overlapping_removals[{first}-{state}]"
        for first in ("writer-first", "initializer-first")
        for state in ("empty", "partial")
    ),
    *(
        "tests/test_scoreboard_projection.py::"
        f"test_postgres_initialization_after_removal_rollback[{state}]"
        for state in ("empty", "partial")
    ),
    *(
        "tests/test_scoreboard_projection.py::"
        f"test_postgres_initialization_after_removal_cancellation[{state}]"
        for state in ("empty", "partial")
    ),
    *(
        "tests/test_scoreboard_projection.py::"
        f"test_postgres_waiting_initializer_cancellation[{cancelled}-{state}]"
        for cancelled in ("init-1", "init-2")
        for state in ("empty", "partial")
    ),
}


class Evidence:
    def __init__(self):
        self.passed = set()
        self.skipped = set()

    def pytest_runtest_logreport(self, report):
        if report.skipped:
            self.skipped.add(report.nodeid)
        if report.when == "call" and report.passed:
            self.passed.add(report.nodeid)

    def pytest_sessionfinish(self, session, exitstatus):
        missing = EXPECTED - self.passed
        ok = exitstatus == 0 and not self.skipped and not missing
        print(
            f"\n[scoreboard-concurrency] {'PASS' if ok else 'FAIL'}: "
            f"required PostgreSQL cases passed={len(EXPECTED & self.passed)}/"
            f"{len(EXPECTED)}, skipped={len(self.skipped)}",
            flush=True,
        )
        if not ok:
            if missing:
                print("[scoreboard-concurrency] missing required cases: "
                      + ", ".join(sorted(missing)), flush=True)
            session.exitstatus = 1


def network_guard(private_root):
    """Allow only private temporary-directory Unix sockets in the child."""
    def guard(event, args):
        if event in {"socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr",
                     "socket.sendto"}:
            raise RuntimeError("Scoreboard concurrency tests forbid external networking")
        if event == "socket.connect":
            sock, address = args
            if (sock.family != socket.AF_UNIX or not isinstance(address, str)
                    or not Path(address).resolve().is_relative_to(private_root)):
                raise RuntimeError(
                    "Scoreboard concurrency tests allow only their private Unix sockets"
                )

    return guard


def child():
    # PostgreSQL uses a private Unix socket; external network access fails closed.
    private_root = Path(os.environ["TMPDIR"]).resolve()
    sys.addaudithook(network_guard(private_root))
    sys.path.insert(0, str(API))
    os.chdir(API)
    import pytest

    return pytest.main(
        [
            "-p", "pytest_asyncio.plugin",
            "tests/test_scoreboard_projection.py", "-v", "-ra",
        ],
        plugins=[Evidence()],
    )


def main():
    tools = {name: shutil.which(name) for name in TOOLS}
    missing = [name for name, path in tools.items() if not path]
    if missing:
        print("[scoreboard-concurrency] FAIL: missing local PostgreSQL binaries: "
              + ", ".join(missing) + "; no tests executed", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="scoreboard-release-") as directory:
        # Explicit allowlist: never inherit app credentials, PG settings,
        # pytest overrides, proxies, or production polling configuration.
        env = {
            "PATH": os.pathsep.join(sorted({str(Path(p).parent) for p in tools.values()})),
            "HOME": directory,
            "TMPDIR": directory,
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
            "REQUIRE_LOCAL_POSTGRES": "1",
        }
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--isolated-child"],
            cwd=ROOT, env=env, check=False,
        )
        return result.returncode


if __name__ == "__main__":
    if sys.argv[1:] == ["--isolated-child"]:
        raise SystemExit(child())
    if sys.argv[1:]:
        raise SystemExit("No database target or test-selection arguments are accepted")
    raise SystemExit(main())
