"""Offline curl release harness. Invoked with a deadline by validate-python.py.

This is a regression guard, not a sandbox for hostile Python. Only synthetic
worker execs and in-memory SQLite are allowed; no application credentials or
network services are needed.
"""

import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "artifacts/api-server/python"
SCRIPT = str(Path(__file__).resolve())
SUITE = "tests/test_public_curl.py"

# Pin safety-critical parameterizations so deleting/renaming them cannot
# silently reduce release evidence. All other collected cases must pass too.
REQUIRED = {
    *(f"test_interrupted_queued_work_keeps_account_admission[{interruption}]"
      for interruption in ("cancel", "timeout")),
    *(f"test_interrupted_wait_keeps_slot_until_worker_exits[{worker_fails}-{interruption}]"
      for worker_fails in ("False", "True") for interruption in ("cancel", "timeout")),
    "test_executor_submission_failure_releases_player",
    *(f"test_whole_worker_deadline_kills_stalled_stage_and_recovers[{stage}]"
      for stage in ("dns", "connect", "tls", "headers", "body", "cleanup")),
    *(f"test_child_failure_reaps_worker_and_releases_capacity[{mode}-{error}]"
      for mode, error in (("dns-error", "OSError"), ("crash", "OSError"),
                          ("malformed", "OSError"), ("mixed", "ValueError"))),
    "test_all_stalled_dns_slots_recover_even_after_waiters_leave",
    "test_process_start_failure_releases_both_limits",
    *(f"test_parent_communicate_failure_reaps_worker_and_releases_both_limits[{case}]"
      for case in ("retained", "cancel-before-kill", "timeout-before-kill",
                   "cancel-before-reap", "timeout-before-reap")),
    "test_repeated_child_failures_keep_parent_descriptors_stable",
    "test_worker_deadline_route_error_is_sanitized_and_recovers",
    "test_mixed_public_private_dns_is_rejected",
    "test_public_pinned_connection_and_no_redirect",
    "test_tls_uses_default_verification_and_original_host",
    *(f"test_worker_environment_excludes_parent_secrets_and_overrides[{scheme}]"
      for scheme in ("http", "https")),
    *(f"test_worker_cannot_access_inheritable_parent_descriptor[{scheme}]"
      for scheme in ("http", "https")),
    "test_imds_browsable_tree_and_only_role_credentials_reveal_flag",
}


def install_guard(directory: Path, *, worker=False):
    violation = directory / "blocked-operation"

    def deny(event):
        # Persist across threads, caught exceptions, and killed child workers.
        # Never print targets, arguments, environment contents, or credentials.
        violation.touch()
        raise RuntimeError(f"Offline curl validation forbids: {event}")

    def guard(event, args):
        if event in {
            "socket.connect", "socket.bind", "socket.getaddrinfo",
            "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto",
            "socket.sendmsg", "os.system", "os.posix_spawn", "os.fork",
            "os.forkpty", "os.exec",
        }:
            deny(event)
        if event == "socket.__new__" and args[1] != socket.AF_UNIX:
            deny(event)
        if event == "sqlite3.connect" and args[0] != ":memory:":
            deny("non-memory database")
        if event == "open" and isinstance(args[0], (str, bytes)):
            name = Path(os.fsdecode(args[0])).name
            if name == ".env" or name.startswith(".env."):
                deny("dotenv read")
        if event == "subprocess.Popen":
            executable, argv, cwd, env = args
            if (worker or executable != sys.executable or not isinstance(argv, list)
                    or len(argv) != 7
                    or argv[:5] != [sys.executable, "-E", SCRIPT, "--worker", str(directory)]
                    or Path(cwd).resolve() != API or env != {}):
                deny("unapproved subprocess")

    sys.addaudithook(guard)
    return violation


class Evidence:
    def __init__(self, violation):
        self.violation = violation
        self.collected = set()
        self.passed = set()
        self.skipped = set()
        self.deselected = False

    def pytest_collection_finish(self, session):
        self.collected = {item.nodeid for item in session.items}

    def pytest_deselected(self, items):
        self.deselected = bool(items) or self.deselected

    def pytest_runtest_logreport(self, report):
        if report.skipped:
            self.skipped.add(report.nodeid)
        if report.when == "call" and report.passed:
            self.passed.add(report.nodeid)

    def pytest_sessionfinish(self, session, exitstatus):
        executed = {node.rsplit("::", 1)[-1] for node in self.passed}
        ok = (exitstatus == 0 and bool(self.collected)
              and self.collected == self.passed and not self.skipped
              and not self.deselected and REQUIRED <= executed
              and not self.violation.exists())
        print(
            f"\n[public-curl] {'PASS' if ok else 'FAIL'}: "
            f"collected={len(self.collected)}, passed={len(self.passed)}, "
            f"skipped={len(self.skipped)}, blocked={self.violation.exists()}; "
            "synthetic transport and in-memory SQLite only",
            flush=True,
        )
        if not ok:
            session.exitstatus = 1


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in {"--suite", "--worker"}:
        raise SystemExit("Use validate-python.py --curl; no test-selection arguments accepted")
    worker = sys.argv[1] == "--worker"
    if len(sys.argv) != (5 if worker else 3):
        raise SystemExit("Unexpected offline curl harness arguments")
    directory = Path(sys.argv[2]).resolve()
    # Isolate the suite, but leave worker startup unchanged so it can prove
    # production supplied a minimal environment rather than hide inheritance.
    if not worker:
        os.environ.clear()
        os.environ.update({
            "HOME": str(directory), "TMPDIR": str(directory),
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        })
    violation = install_guard(directory, worker=worker)
    sys.path.insert(0, str(API))
    os.chdir(API)
    if worker:
        sys.argv = ["tests.public_curl_stub", *sys.argv[3:]]
        runpy.run_module("tests.public_curl_stub", run_name="__main__")
        return 1 if violation.exists() else 0

    real_popen = subprocess.Popen

    def guarded_popen(command, **kwargs):
        # The suite's real exec fixture alone may launch children, each with
        # this same audit guard installed before importing app/test modules.
        if (not isinstance(command, list) or len(command) != 6
                or command[:4] != [sys.executable, "-E", "-m", "tests.public_curl_stub"]):
            violation.touch()
            raise RuntimeError("Offline curl validation forbids unapproved worker")
        return real_popen(
            [sys.executable, "-E", SCRIPT, "--worker", str(directory), *command[4:]],
            **kwargs,
        )

    subprocess.Popen = guarded_popen
    import pytest

    return pytest.main([
        "-c", "/dev/null", "-p", "pytest_asyncio.plugin",
        "-o", "asyncio_mode=auto", "-o", "asyncio_default_fixture_loop_scope=function",
        "-p", "no:cacheprovider", "--confcutdir", str(API), SUITE, "-q", "-ra",
    ], plugins=[Evidence(violation)])


if __name__ == "__main__":
    raise SystemExit(main())
