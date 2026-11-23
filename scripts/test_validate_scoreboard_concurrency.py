"""Offline regressions for strict scoreboard concurrency evidence."""

import importlib.util
from pathlib import Path
import runpy
import socket
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "scoreboard_validation", Path(__file__).with_name("validate-scoreboard-concurrency.py")
)
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


class ScoreboardValidationTests(unittest.TestCase):
    def test_missing_binaries_fail_before_running_tests(self):
        with patch.object(validation.shutil, "which", return_value=None), \
                patch.object(validation.subprocess, "run") as run:
            self.assertEqual(validation.main(), 1)
            run.assert_not_called()

    def test_evidence_requires_all_cases(self):
        evidence = validation.Evidence()
        session = SimpleNamespace(exitstatus=0)
        evidence.pytest_sessionfinish(session, 0)
        self.assertEqual(session.exitstatus, 1)

    def test_every_destructive_case_is_required(self):
        removals = {
            "tests/test_scoreboard_projection.py::"
            f"test_postgres_initialization_overlapping_removals[{first}-{state}]"
            for first in ("writer-first", "initializer-first")
            for state in ("empty", "partial")
        }
        removals.update(
            "tests/test_scoreboard_projection.py::"
            f"test_postgres_initialization_after_removal_{interruption}[{state}]"
            for interruption in ("rollback", "cancellation")
            for state in ("empty", "partial")
        )
        removals.update(
            "tests/test_scoreboard_projection.py::"
            f"test_postgres_waiting_initializer_cancellation[{cancelled}-{state}]"
            for cancelled in ("init-1", "init-2")
            for state in ("empty", "partial")
        )
        self.assertTrue(removals <= validation.EXPECTED)
        self.assertEqual(len(validation.EXPECTED), 20)
        for missing in removals:
            with self.subTest(missing=missing):
                evidence = validation.Evidence()
                evidence.passed = validation.EXPECTED - {missing}
                session = SimpleNamespace(exitstatus=0)
                evidence.pytest_sessionfinish(session, 0)
                self.assertEqual(session.exitstatus, 1)

    def test_each_waiter_cancellation_case_rejects_skipped_evidence(self):
        for cancelled in ("init-1", "init-2"):
            for state in ("empty", "partial"):
                nodeid = (
                    "tests/test_scoreboard_projection.py::"
                    f"test_postgres_waiting_initializer_cancellation[{cancelled}-{state}]"
                )
                with self.subTest(nodeid=nodeid):
                    self.assertIn(nodeid, validation.EXPECTED)
                    evidence = validation.Evidence()
                    for required in validation.EXPECTED:
                        evidence.pytest_runtest_logreport(SimpleNamespace(
                            nodeid=required, when="call",
                            passed=required != nodeid, skipped=required == nodeid,
                        ))
                    session = SimpleNamespace(exitstatus=0)
                    evidence.pytest_sessionfinish(session, 0)
                    self.assertEqual(session.exitstatus, 1)

    def test_each_partially_locked_cancellation_case_requires_passing_evidence(self):
        for state in ("empty", "partial"):
            nodeid = (
                "tests/test_scoreboard_projection.py::"
                f"test_postgres_partially_locked_initializer_cancellation[{state}]"
            )
            for outcome in ("missing", "skipped", "failed"):
                with self.subTest(nodeid=nodeid, outcome=outcome):
                    self.assertIn(nodeid, validation.EXPECTED)
                    evidence = validation.Evidence()
                    for required in validation.EXPECTED:
                        if required == nodeid and outcome == "missing":
                            continue
                        evidence.pytest_runtest_logreport(SimpleNamespace(
                            nodeid=required, when="call", passed=required != nodeid,
                            skipped=required == nodeid and outcome == "skipped",
                        ))
                    session = SimpleNamespace(exitstatus=0)
                    evidence.pytest_sessionfinish(session, 0)
                    self.assertEqual(session.exitstatus, 1)

    def test_success_and_skip_fail_closed(self):
        evidence = validation.Evidence()
        for nodeid in validation.EXPECTED:
            evidence.pytest_runtest_logreport(SimpleNamespace(
                nodeid=nodeid, when="call", passed=True, skipped=False,
            ))
        session = SimpleNamespace(exitstatus=0)
        evidence.pytest_sessionfinish(session, 0)
        self.assertEqual(session.exitstatus, 0)
        evidence.skipped.add("some-new-case")
        evidence.pytest_sessionfinish(session, 0)
        self.assertEqual(session.exitstatus, 1)

    def test_each_flushed_cancellation_case_requires_passing_evidence(self):
        for state in ("empty", "partial"):
            nodeid = (
                "tests/test_scoreboard_projection.py::"
                f"test_postgres_flushed_initializer_cancellation[{state}]"
            )
            for outcome in ("missing", "skipped", "failed"):
                with self.subTest(nodeid=nodeid, outcome=outcome):
                    self.assertIn(nodeid, validation.EXPECTED)
                    evidence = validation.Evidence()
                    for required in validation.EXPECTED:
                        if required == nodeid and outcome == "missing":
                            continue
                        evidence.pytest_runtest_logreport(SimpleNamespace(
                            nodeid=required, when="call", passed=required != nodeid,
                            skipped=required == nodeid and outcome == "skipped",
                        ))
                    session = SimpleNamespace(exitstatus=0)
                    evidence.pytest_sessionfinish(session, 0)
                    self.assertEqual(session.exitstatus, 1)

    def test_child_failure_propagates_and_environment_is_allowlisted(self):
        with patch.object(validation.shutil, "which", side_effect=lambda n: f"/bin/{n}"), \
                patch.object(validation.subprocess, "run",
                             return_value=SimpleNamespace(returncode=7)) as run:
            self.assertEqual(validation.main(), 7)
            self.assertEqual(set(run.call_args.kwargs["env"]), {
                "PATH", "HOME", "TMPDIR", "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
                "REQUIRE_LOCAL_POSTGRES",
            })
            self.assertEqual(run.call_args.args[0][-1], "--isolated-child")

    def test_network_guard_allows_only_private_unix_socket(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            private_socket = socket.socket(socket.AF_UNIX)
            guard = validation.network_guard(root)
            guard("socket.connect", (private_socket, str(root / "pg.sock")))
            with self.assertRaisesRegex(RuntimeError, "private Unix sockets"):
                guard("socket.connect", (private_socket, "/tmp/outside.sock"))
            with self.assertRaisesRegex(RuntimeError, "external networking"):
                guard("socket.getaddrinfo", ())
            private_socket.close()

    def test_arguments_are_rejected_before_runner_invocation(self):
        script = Path(__file__).with_name("validate-scoreboard-concurrency.py")
        with patch("sys.argv", [str(script), "postgres://target"]):
            with self.assertRaisesRegex(SystemExit, "No database target"):
                runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    unittest.main()
