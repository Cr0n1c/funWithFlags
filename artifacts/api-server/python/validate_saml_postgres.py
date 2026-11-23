"""Fail-closed, secret-safe entry point for the separately approved PostgreSQL job."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

CASES = ("jit", "transaction_replay", "assertion_replay")
PREFIX = "tests/test_saml_postgres.py::test_concurrent_saml_postgres"
EXPECTED = {f"{PREFIX}[{case}]" for case in CASES}
PHASES = ("setup", "call", "teardown")


class Results:
    """Store outcomes only: never persist exception text, captured logs or credentials."""

    def __init__(self, path):
        self.path = path
        self.reports = {}
        self.collected = []
        self.collection_errors = 0

    def pytest_collection_finish(self, session):
        self.collected = [item.nodeid for item in session.items]

    def pytest_collectreport(self, report):
        if report.failed:
            self.collection_errors += 1

    def pytest_runtest_logreport(self, report):
        if report.nodeid in EXPECTED:
            self.reports.setdefault(report.nodeid, {}).setdefault(report.when, []).append(
                report.outcome
            )

    def pytest_sessionfinish(self, session, exitstatus):
        # Record only known IDs, plus counts to catch missing or unexpected tests.
        self.path.write_text(json.dumps({
            "collected": sorted(set(self.collected) & EXPECTED),
            "count": len(self.collected),
            "collection_errors": self.collection_errors,
            "reports": self.reports,
        }))


def successful(result):
    return (
        result.get("count") == 3
        and set(result.get("collected", [])) == EXPECTED
        and result.get("collection_errors") == 0
        and set(result.get("reports", {})) == EXPECTED
        and all(
            result["reports"][node].get(phase) == ["passed"]
            for node in EXPECTED for phase in PHASES
        )
    )


def gate(env):
    if env.get("ENVIRONMENT") != "development":
        return "ENVIRONMENT must explicitly be development."
    if env.get("SAML_TEST_POSTGRES_APPROVAL") != "dedicated-nonproduction":
        return "Explicit approval of a dedicated non-production database is required."
    if not env.get("SAML_TEST_POSTGRES_URL", "").startswith("postgresql+asyncpg://"):
        return "A dedicated asyncpg test URL is required; application DB settings are not used."
    return None


def main():
    error = gate(os.environ)
    if error:
        print("PostgreSQL validation BLOCKED: " + error)
        return 2
    env = dict(os.environ)
    # Prevent user pytest options/plugins from skipping cases, dumping credentials,
    # or redirecting reports. Do not inherit the application's database credentials.
    for key in list(env):
        if key.startswith(("PYTEST_", "DB_")) or key == "DATABASE_URL":
            env.pop(key)
    env.update({
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        "SAML_TEST_POSTGRES": "1",
        "SESSION_SECRET": "isolated-test-session-secret-not-for-production",
        "FLAG_HASH_SECRET": "isolated-test-flag-secret-not-for-production",
    })
    with tempfile.TemporaryDirectory(prefix="saml-validation-") as directory:
        report = Path(directory) / "outcomes.json"
        try:
            completed = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--child", str(report)],
                cwd=Path(__file__).resolve().parent, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=180, check=False,
            )
            result = json.loads(report.read_text())
        except subprocess.TimeoutExpired:
            print("PostgreSQL validation FAILED: timeout; schema cleanup may need operator attention.")
            return 1
        except (OSError, ValueError):
            print("PostgreSQL validation FAILED: no valid outcome report; cleanup not confirmed.")
            return 1
        for case in CASES:
            phases = result.get("reports", {}).get(f"{PREFIX}[{case}]", {})
            statuses = []
            for phase in PHASES:
                values = phases.get(phase, [])
                status = values[0] if len(values) == 1 and values[0] in (
                    "passed", "failed", "skipped"
                ) else "missing-or-invalid"
                statuses.append(f"{phase}={status}")
            print(f"{case}: " + ", ".join(statuses))
        passed = completed.returncode == 0 and successful(result)
        print("PostgreSQL validation " + (
            "PASSED: all three cases and their teardown passed."
            if passed else "FAILED: requires exactly three cases, no skips, and successful teardown."
        ))
        return 0 if passed else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        import pytest

        sys.exit(pytest.main([
            "-p", "pytest_asyncio.plugin", "tests/test_saml_postgres.py",
            "-q", "--tb=no", "--no-header", "-o", "addopts=",
        ], plugins=[Results(Path(sys.argv[2]))]))
    sys.exit(main())