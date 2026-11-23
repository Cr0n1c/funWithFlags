"""Runner safeguards; probes use synthetic targets and disposable source copies."""

import contextlib
import importlib.util
import io
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CurlEvidenceTests(unittest.TestCase):
    def test_account_capacity_cases_are_required(self):
        harness = load("validate-public-curl")
        # Independent expectations: removing a pin must fail even if the
        # remaining suite (and the general evidence checks below) still passes.
        expected = {
            "test_interrupted_queued_work_keeps_account_admission[cancel]",
            "test_interrupted_queued_work_keeps_account_admission[timeout]",
            "test_interrupted_wait_keeps_slot_until_worker_exits[False-cancel]",
            "test_interrupted_wait_keeps_slot_until_worker_exits[False-timeout]",
            "test_interrupted_wait_keeps_slot_until_worker_exits[True-cancel]",
            "test_interrupted_wait_keeps_slot_until_worker_exits[True-timeout]",
            "test_executor_submission_failure_releases_player",
        }
        self.assertTrue(expected <= harness.REQUIRED,
                        f"Missing account-capacity pins: {expected - harness.REQUIRED}")

    def test_each_required_case_must_pass_under_its_pinned_name(self):
        harness = load("validate-public-curl")
        with tempfile.TemporaryDirectory() as directory:
            for name in sorted(harness.REQUIRED):
                for change in ("deleted", "renamed"):
                    with self.subTest(case=name, change=change):
                        evidence = harness.Evidence(Path(directory) / "blocked-operation")
                        nodes = {f"suite::{case}" for case in harness.REQUIRED}
                        nodes.remove(f"suite::{name}")
                        if change == "renamed":
                            nodes.add(f"suite::renamed_{name}")
                        evidence.pytest_collection_finish(SimpleNamespace(
                            items=[SimpleNamespace(nodeid=node) for node in nodes],
                        ))
                        for node in nodes:
                            evidence.pytest_runtest_logreport(SimpleNamespace(
                                nodeid=node, when="call", passed=True, skipped=False,
                            ))
                        # Every remaining test passes, and pytest itself exits
                        # successfully: only the required-evidence gate can fail.
                        session = SimpleNamespace(exitstatus=0)
                        with contextlib.redirect_stdout(io.StringIO()) as output:
                            evidence.pytest_sessionfinish(session, 0)
                        self.assertEqual(session.exitstatus, 1)
                        self.assertIn("[public-curl] FAIL", output.getvalue())

    def test_root_declares_and_locks_offline_suite_dependencies(self):
        # The deployment build runs uv sync at the root, not the nested API's dev group.
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        declared = {
            re.match(r"[A-Za-z0-9_.-]+", dependency).group(0).lower().replace("_", "-")
            for dependency in project["project"]["dependencies"]
        }
        required = {"pytest", "pytest-asyncio", "aiosqlite"}
        self.assertTrue(required <= declared, f"Missing release dependencies: {required - declared}")
        lock = tomllib.loads((ROOT / "uv.lock").read_text())
        self.assertTrue(required <= {package["name"] for package in lock["package"]})

    def test_missing_skipped_deselected_and_failed_cases_never_pass(self):
        harness = load("validate-public-curl")
        with tempfile.TemporaryDirectory() as directory:
            for problem in (None, "missing", "skipped", "deselected", "failed", "blocked", "empty"):
                with self.subTest(problem=problem):
                    marker = Path(directory) / str(problem)
                    evidence = harness.Evidence(marker)
                    nodes = {f"suite::{name}" for name in harness.REQUIRED}
                    evidence.collected = nodes.copy()
                    evidence.passed = nodes.copy()
                    if problem == "missing":
                        evidence.passed.pop()
                        evidence.collected = evidence.passed.copy()
                    elif problem == "skipped":
                        evidence.skipped.add(next(iter(nodes)))
                    elif problem == "deselected":
                        evidence.pytest_deselected([object()])
                    elif problem == "blocked":
                        marker.touch()
                    elif problem == "empty":
                        evidence.collected.clear()
                        evidence.passed.clear()
                    session = SimpleNamespace(exitstatus=0)
                    with contextlib.redirect_stdout(io.StringIO()):
                        evidence.pytest_sessionfinish(session, 1 if problem == "failed" else 0)
                    self.assertEqual(session.exitstatus, 0 if problem is None else 1)


class CurlIsolationTests(unittest.TestCase):
    def probe(self, injected, *, worker=False, worker_environment=None):
        with tempfile.TemporaryDirectory(prefix="curl-guard-test-") as directory:
            root = Path(directory)
            scripts = root / "scripts"
            scripts.mkdir()
            shutil.copyfile(ROOT / "scripts/validate-public-curl.py",
                            scripts / "validate-public-curl.py")
            tests = root / "artifacts/api-server/python/tests"
            tests.mkdir(parents=True)
            (tests / "__init__.py").touch()
            source = tests / ("public_curl_stub.py" if worker else "test_public_curl.py")
            source.write_text(injected)
            command = [
                sys.executable, "-B", str(scripts / "validate-public-curl.py"),
                "--worker" if worker else "--suite", directory,
            ]
            if worker:
                command += ["success", str(root / "marker")]
            result = subprocess.run(
                command, env=(worker_environment or {}) if worker else {
                    "DATABASE_URL": "synthetic-parent-db-must-not-be-used",
                    "FLAG_HASH_SECRET": "synthetic-parent-secret",
                    "PYTEST_ADDOPTS": "--collect-only",
                    "PYTEST_PLUGINS": "missing_hostile_plugin",
                    "HTTP_PROXY": "http://synthetic.invalid",
                }, text=True, capture_output=True, timeout=15,
            )
            return result, (root / "blocked-operation").exists()

    def test_suite_is_cleared_and_worker_keeps_production_environment(self):
        for worker in (False, True):
            allowed = (
                "{'LC_CTYPE', 'LD_LIBRARY_PATH'}" if worker else
                "{'HOME', 'TMPDIR', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD', 'PYTEST_VERSION'}"
            )
            result, blocked = self.probe(
                "import os\n"
                f"assert set(os.environ) <= {allowed}\n"
                "print('synthetic environment verified')\n", worker=worker,
            )
            self.assertFalse(blocked)
            self.assertNotIn("AssertionError", result.stdout + result.stderr)
            if worker:
                self.assertEqual(result.returncode, 0, result.stderr)
            else:
                # No tests is a failure, not successful release evidence.
                self.assertNotEqual(result.returncode, 0)

    def test_caught_external_operations_fail_in_parent_and_worker(self):
        probes = [
            "import socket; socket.getaddrinfo('synthetic.invalid', 80)",
            "import socket; socket.socket().connect(('169.254.169.254', 80))",
            "import socket; socket.socket().connect(('10.0.0.1', 5432))",
            "import sqlite3; sqlite3.connect('application.sqlite')",
            "open('.env')",
            "import subprocess; subprocess.Popen(['unapproved-command'])",
        ]
        for worker in (False, True):
            for probe in probes:
                with self.subTest(worker=worker, probe=probe):
                    result, blocked = self.probe(
                        f"try:\n    {probe}\nexcept Exception:\n    pass\n", worker=worker,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue(blocked, result.stdout + result.stderr)

    def test_worker_bootstrap_does_not_hide_environment_leaks(self):
        result, blocked = self.probe(
            "import os\n"
            "assert os.environ['SYNTHETIC_LEAK_PROBE'] == 'synthetic-only'\n",
            worker=True, worker_environment={"SYNTHETIC_LEAK_PROBE": "synthetic-only"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(blocked)

    def test_only_in_memory_sqlite_is_allowed(self):
        result, blocked = self.probe(
            "import sqlite3\n"
            "db = sqlite3.connect(':memory:')\n"
            "assert db.execute('select 1').fetchone() == (1,)\n"
            "db.close()\n", worker=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(blocked)


class CurlControllerTests(unittest.TestCase):
    def test_default_runs_curl_but_setup_only_does_not(self):
        runner = load("validate-python")
        with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                patch.object(runner, "curl_checks", return_value=7) as curl:
            self.assertEqual(runner.main(), 7)
            curl.assert_called_once_with()
            curl.reset_mock()
            self.assertEqual(runner.main(setup_only=True), 0)
            curl.assert_not_called()

    def test_launch_is_bounded_secret_free_and_always_cleans_process_group(self):
        runner = load("validate-python")
        for status in (0, 1, 5, 127, "timeout"):
            with self.subTest(status=status):
                process = unittest.mock.Mock(pid=123456)
                process.wait.side_effect = (
                    [subprocess.TimeoutExpired("synthetic", 180), 0]
                    if status == "timeout" else [status, status]
                )
                with patch.object(runner.subprocess, "Popen", return_value=process) as launch, \
                        patch.object(runner.os, "killpg") as kill:
                    self.assertEqual(runner.curl_checks(), 0 if status == 0 else 1)
                self.assertEqual(launch.call_args.kwargs["env"], {})
                self.assertTrue(launch.call_args.kwargs["start_new_session"])
                self.assertEqual(process.wait.call_args_list[0].kwargs, {"timeout": 180})
                kill.assert_called_once_with(process.pid, runner.signal.SIGKILL)

    def test_real_timeout_stops_suite_and_descendant(self):
        runner = load("validate-python")
        with tempfile.TemporaryDirectory(prefix="curl-timeout-test-") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            pidfile = root / "pid"
            (root / "scripts/validate-public-curl.py").write_text(
                "import pathlib, subprocess, sys, time\n"
                "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
                f"pathlib.Path({str(pidfile)!r}).write_text(str(p.pid))\n"
                "time.sleep(60)\n"
            )
            with patch.object(runner, "ROOT", root):
                self.assertEqual(runner.curl_checks(timeout=1), 1)
            pid = int(pidfile.read_text())
            # An orphan can briefly remain a zombie until PID 1 reaps it, but
            # it must not remain running after group cleanup.
            import time
            for _ in range(100):
                stat = Path(f"/proc/{pid}/stat")
                try:
                    state = stat.read_text().split()[2]
                except (FileNotFoundError, ProcessLookupError):
                    # PID 1 can reap the stopped descendant during open/read;
                    # an exists() check cannot make this snapshot atomic.
                    break
                if state == "Z":
                    break
                time.sleep(0.01)
            else:
                self.fail("Timed-out curl descendant is still running")


if __name__ == "__main__":
    unittest.main()
