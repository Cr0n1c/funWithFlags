"""Offline checks of the release gate; never open a database connection."""

import json
import subprocess
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

import validate_saml_postgres as validation
from validate_saml_postgres import CASES, EXPECTED, PHASES, PREFIX, gate, successful


def good_result():
    return {
        "count": 3,
        "collected": sorted(EXPECTED),
        "collection_errors": 0,
        "reports": {node: {phase: ["passed"] for phase in PHASES} for node in EXPECTED},
    }


def test_requires_explicit_approval_and_dedicated_target():
    env = {
        "ENVIRONMENT": "development",
        "SAML_TEST_POSTGRES_APPROVAL": "dedicated-nonproduction",
        "SAML_TEST_POSTGRES_URL": "postgresql+asyncpg://unused.invalid/test",
    }
    assert gate(env) is None
    for key in env:
        assert gate({k: v for k, v in env.items() if k != key})
    assert gate({**env, "ENVIRONMENT": "production"})
    assert gate({**env, "SAML_TEST_POSTGRES_URL": "sqlite://"})
    assert gate({"ENVIRONMENT": "development", "DATABASE_URL": env["SAML_TEST_POSTGRES_URL"]})


def test_accepts_only_complete_success():
    assert successful(good_result())
    for key, value in (
        ("count", 0),
        ("count", 4),
        ("collected", []),
        ("collection_errors", 1),
        ("reports", {}),
    ):
        assert not successful({**good_result(), key: value})


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("phase", PHASES)
@pytest.mark.parametrize("outcomes", [[], ["skipped"], ["failed"], ["passed", "passed"]])
def test_rejects_missing_skipped_failed_or_duplicate_phase(case, phase, outcomes):
    result = deepcopy(good_result())
    result["reports"][f"{PREFIX}[{case}]"][phase] = outcomes
    assert not successful(result)


@pytest.mark.parametrize("mode", ["passed", "skipped", "teardown", "exit", "timeout", "missing"])
def test_runner_exit_and_safe_output(monkeypatch, capsys, mode):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("SAML_TEST_POSTGRES_APPROVAL", "dedicated-nonproduction")
    monkeypatch.setenv("SAML_TEST_POSTGRES_URL", "postgresql+asyncpg://do-not-print.invalid/test")
    monkeypatch.setenv("DATABASE_URL", "must-not-be-inherited")
    monkeypatch.setenv("PYTEST_ADDOPTS", "-k skip-everything")

    def run(args, **kwargs):
        assert "DATABASE_URL" not in kwargs["env"]
        assert "PYTEST_ADDOPTS" not in kwargs["env"]
        assert kwargs["env"]["SAML_TEST_POSTGRES"] == "1"
        assert kwargs["stdout"] == kwargs["stderr"] == subprocess.DEVNULL
        if mode == "timeout":
            raise subprocess.TimeoutExpired(args, 180)
        result = good_result()
        node = f"{PREFIX}[jit]"
        if mode == "skipped":
            result["reports"][node]["call"] = ["skipped"]
        if mode == "teardown":
            result["reports"][node]["teardown"] = ["failed"]
        if mode != "missing":
            Path(args[-1]).write_text(json.dumps(result))
        return SimpleNamespace(returncode=1 if mode == "exit" else 0)

    monkeypatch.setattr(validation.subprocess, "run", run)
    assert validation.main() == (0 if mode == "passed" else 1)
    output = capsys.readouterr().out
    assert "do-not-print" not in output
    assert "must-not-be-inherited" not in output
    if mode == "teardown":
        assert "teardown=failed" in output


def test_blocked_runner_never_starts_child(monkeypatch, capsys):
    monkeypatch.delenv("SAML_TEST_POSTGRES_APPROVAL", raising=False)

    def forbidden(*args, **kwargs):
        pytest.fail("blocked validation must not launch tests")

    monkeypatch.setattr(validation.subprocess, "run", forbidden)
    assert validation.main() == 2
    assert "BLOCKED" in capsys.readouterr().out
