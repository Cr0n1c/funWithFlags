"""Regression checks in disposable source copies; never edit the working app."""

from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ReleaseGateTests(unittest.TestCase):
    def run_gate(self, python_status=0, frontend_status=0, browser_status=0,
                 curl_status=0, security_status=0, setup_only=False):
        command = ["bash", "scripts/validate-merged.sh"]
        if setup_only:
            command = [*command, "--setup-only"]
        with tempfile.TemporaryDirectory(prefix="release-gate-") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            shutil.copyfile(ROOT / "scripts/validate-merged.sh", root / "scripts/validate-merged.sh")
            bin_dir = root / "bin"
            bin_dir.mkdir()
            stubs = {
                "python": (
                    'case "$*" in\n'
                    '"scripts/validate-python.py --setup-only")\n'
                    f'echo python >> "{root / "calls"}"; exit {python_status};;\n'
                    '"scripts/validate-python.py --curl")\n'
                    f'echo curl >> "{root / "calls"}"; exit {curl_status};;\n'
                    '*) exit 99;;\nesac\n'
                ),
                "pnpm": (
                    'case "$*" in\n'
                    '"--filter @workspace/fun-with-flags run type-check")\n'
                    f'echo type-check >> "{root / "calls"}"; exit {frontend_status};;\n'
                    '"--filter @workspace/fun-with-flags run test:browser")\n'
                    f'echo browser >> "{root / "calls"}"; exit {browser_status};;\n'
                    '*) exit 99;;\nesac\n'
                ),
                "node": (
                    'case "$*" in\n'
                    '"scripts/test-braces-nesting.mjs")\n'
                    f'echo braces-security >> "{root / "calls"}"; exit {security_status};;\n'
                    '*) exit 99;;\nesac\n'
                ),
                "timeout": (
                    # Validate the actual budgets without waiting for a timeout.
                    'case "$*" in\n'
                    '"45s python scripts/validate-python.py --setup-only"|"60s pnpm --filter @workspace/fun-with-flags run type-check") shift;;\n'
                    '"--kill-after=10s 200s python scripts/validate-python.py --curl") shift 2;;\n'
                    '"--kill-after=10s 900s pnpm --filter @workspace/fun-with-flags run test:browser") shift 2;;\n'
                    '*) exit 99;;\nesac\nexec "$@"\n'
                ),
            }
            for name, body in stubs.items():
                executable = bin_dir / name
                executable.write_text('#!/bin/bash\n' + body)
                executable.chmod(0o755)
            result = subprocess.run(
                command, cwd=root,
                env={"PATH": f"{bin_dir}:{os.defpath}"},
                text=True, capture_output=True, timeout=10,
            )
            return result, (root / "calls").read_text().splitlines()

    def test_release_gate_success(self):
        result, calls = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(calls, ["python", "type-check", "braces-security", "curl", "browser"])
        self.assertIn("PASS:", result.stdout)

    def test_setup_only_is_explicit_and_does_not_claim_release_validation(self):
        result, calls = self.run_gate(setup_only=True, browser_status=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(calls, ["python", "type-check", "braces-security"])
        self.assertIn("Browser release validation not run", result.stdout)
        self.assertIn("Curl release validation not run", result.stdout)

    def test_setup_still_fails_on_startup_or_type_errors(self):
        for statuses in ({"python_status": 7}, {"frontend_status": 2}):
            result, _ = self.run_gate(setup_only=True, **statuses)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("SETUP PASS:", result.stdout)

    def test_release_gate_stops_on_python_failure(self):
        result, calls = self.run_gate(python_status=7)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(calls, ["python"])
        self.assertIn("FAILED: Python compilation and isolated startup", result.stderr)

    def test_release_gate_rejects_frontend_type_errors(self):
        result, calls = self.run_gate(frontend_status=2)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, ["python", "type-check"])
        self.assertIn("FAILED: frontend typecheck", result.stderr)

    def test_release_gate_rejects_braces_nesting_regression(self):
        result, calls = self.run_gate(security_status=7)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(calls, ["python", "type-check", "braces-security"])
        self.assertIn("FAILED: braces nesting security regression", result.stderr)

    def test_release_gate_rejects_browser_failures_and_missing_prerequisites(self):
        for status in (1, 127, 124, 137):
            with self.subTest(status=status):
                result, calls = self.run_gate(browser_status=status)
                self.assertEqual(result.returncode, status)
                self.assertEqual(calls, ["python", "type-check", "braces-security", "curl", "browser"])
                self.assertIn("FAILED: offline Chromium terminal checks", result.stderr)
                self.assertNotIn("PASS:", result.stdout)

    def test_release_gate_rejects_curl_failure_missing_prerequisites_and_timeout(self):
        for status in (1, 127, 124, 137):
            with self.subTest(status=status):
                result, calls = self.run_gate(curl_status=status)
                self.assertEqual(result.returncode, status)
                self.assertEqual(calls, ["python", "type-check", "braces-security", "curl"])
                self.assertIn("FAILED: offline curl safety regressions", result.stderr)
                self.assertNotIn("PASS:", result.stdout)

    def test_post_merge_uses_setup_checks(self):
        hook = (ROOT / "scripts/post-merge.sh").read_text()
        self.assertIn("bash scripts/validate-merged.sh --setup-only", hook)


class MergedValidationTests(unittest.TestCase):
    def run_copy(
        self, injected: str, *, replace_normalization: str | None = None,
        replace_initializer: str | None = None,
    ) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory(prefix="merged-validation-") as directory:
            root = Path(directory)
            api = root / "artifacts/api-server/python"
            shutil.copytree(
                ROOT / "artifacts/api-server/python/app", api / "app",
                ignore=shutil.ignore_patterns("__pycache__"),
            )
            shutil.copyfile(ROOT / "artifacts/api-server/python/run_server.py", api / "run_server.py")
            (root / "scripts").mkdir()
            shutil.copyfile(ROOT / "scripts/validate-python.py", root / "scripts/validate-python.py")
            if replace_normalization is not None:
                main_file = api / "app/main.py"
                original = main_file.read_text()
                target = "await normalize_hash_categories(session)"
                self.assertEqual(original.count(target), 1)
                main_file.write_text(original.replace(target, replace_normalization))
            if replace_initializer is not None:
                main_file = api / "app/main.py"
                original = main_file.read_text()
                target = "await initialize_missing(session)"
                self.assertEqual(original.count(target), 1)
                main_file.write_text(original.replace(target, replace_initializer))
            with (api / "app/routers/admin.py").open("a") as target:
                target.write("\n" + injected + "\n")
            # Synthetic hostile parent settings prove the child ignores ambient
            # runtime signals, startup flags, and DB targets.
            env = {
                "DATABASE_URL": "not-a-valid-database",
                "SLACK_ACTIVITY_WEBHOOK_URL": "https://hooks.slack.com/services/FAKE/FAKE/FAKE",
                "NODE_ENV": "test", "ENVIRONMENT": "test",
                "RUN_MIGRATIONS_ON_STARTUP": "true", "SEED_ON_STARTUP": "true",
            }
            return subprocess.run(
                [sys.executable, str(root / "scripts/validate-python.py"), "--setup-only"],
                cwd=root, env=env, text=True, capture_output=True, timeout=40,
            )

    def test_synthetic_startup_ignores_parent_configuration(self):
        result = self.run_copy("")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("shutdown PASS", result.stdout)

    def test_startup_must_invoke_normalization(self):
        result = self.run_copy("", replace_normalization="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Startup normalization invoked 0 times, expected once", result.stderr)

    def test_direct_database_query_is_blocked_before_network(self):
        result = self.run_copy("", replace_normalization='await session.execute("SELECT 1")')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Isolated startup forbids database queries and commits", result.stderr)
        self.assertNotIn("socket.getaddrinfo", result.stderr)

    def test_startup_cannot_commit_if_initializer_is_skipped(self):
        result = self.run_copy("", replace_initializer="(0, 0)")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Isolated startup forbids database queries and commits", result.stderr)

    def test_initializer_direct_database_query_remains_blocked(self):
        result = self.run_copy(
            "", replace_initializer='await session.execute("SELECT 1")',
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Isolated startup forbids database queries and commits", result.stderr)

    def test_unfinished_import_fails_compilation(self):
        result = self.run_copy("from app.schemas import (")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL: compileall", result.stderr)
        self.assertNotIn("Python isolated startup", result.stdout)

    def test_valid_syntax_missing_import_fails_startup(self):
        result = self.run_copy("from app.schemas import MergedSymbolThatDoesNotExist")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL: isolated startup", result.stderr)

    def test_outbound_call_is_blocked_even_if_caught(self):
        result = self.run_copy(
            "import socket\n"
            "try:\n"
            "    socket.create_connection(('127.0.0.1', 9))\n"
            "except Exception:\n"
            "    pass\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Blocked operations were attempted", result.stderr)

    def test_startup_failure_is_reported(self):
        result = self.run_copy(
            "from app.db import Database\n"
            "def broken_database(*args, **kwargs):\n"
            "    raise RuntimeError('synthetic startup failure')\n"
            "Database.__init__ = broken_database\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("synthetic startup failure", result.stderr)


if __name__ == "__main__":
    unittest.main()