# PostgreSQL SAML concurrency verification

## Approved isolated local run — 2026-09-22

The user approved creating a test database and explicitly deferred GitHub
repository setup. We ran the release-check entry point against a newly created
local PostgreSQL 17.5 cluster, not the managed application database. This is
local verification, **not a dispatched GitHub Actions release check**.

Run from the workspace root:

```sh
bash artifacts/api-server/python/validate_saml_local_postgres.sh
```

The helper creates a fresh temporary cluster for each invocation. TCP is
disabled; its Unix socket and data are inside a private, mode-0700 temporary
directory. Local trust authentication is confined to that private socket;
there is no password to persist. Tests use a non-superuser, non-role-creating,
non-database-creating role which owns only the disposable test database.
The helper does not use the application's connection string or copy any data.
Explicitly invoking this helper selects only its newly created local target;
it does not authorize testing any existing or remote database.

Recorded output:

```text
jit: setup=passed, call=passed, teardown=passed
transaction_replay: setup=passed, call=passed, teardown=passed
assertion_replay: setup=passed, call=passed, teardown=passed
PostgreSQL validation PASSED: all three cases and their teardown passed.
Local PostgreSQL cleanup confirmed: zero test schemas remain.
```

The helper exited successfully after stopping and deleting its temporary
cluster. Normal exit and handled interrupts trigger cleanup; a machine crash
or SIGKILL can still leave temporary files/processes requiring local cleanup.
PostgreSQL binaries and the existing Python test dependencies are required.

The GitHub workflow below remains available but inactive. Its repository,
protected environment, dedicated remote target and environment secret were
not configured or used in this local run.

## Approved development run — 2026-09-22

The user explicitly approved this workspace's managed development PostgreSQL
database before execution. No production database was used. The existing fixture
required `ENVIRONMENT=development` and the asyncpg driver, created a separate
randomly named schema per case, and dropped each schema in teardown. Startup
migrations and seeding were disabled.

Command, from `artifacts/api-server/python`:

```sh
SAML_TEST_POSTGRES=1 python -m pytest tests/test_saml_postgres.py -v --tb=short
```

Result: **3 passed in 2.47 seconds**, with no skipped cases or failures.

| Case | Verified outcome |
| --- | --- |
| `jit` | Both concurrent sign-ins succeeded after a barrier forced both transactions to observe a missing account; only one user was created. |
| `transaction_replay` | Concurrent reuse of one login transaction produced exactly one successful sign-in and one session cookie. |
| `assertion_replay` | Concurrent use of one assertion ID across separate login transactions produced exactly one successful sign-in and one session cookie. |

Every case also asserted exactly one stored user, a replay-record count equal to
the number of successful sign-ins, and no remaining login transactions.

A separate read-only PostgreSQL catalog query after pytest finished confirmed
**zero schemas** matching `^saml_test_[0-9a-f]{32}$` remained.

The run emitted 25 upstream `python3-saml` deprecation warnings concerning
`datetime.utcnow()` and `datetime.utcfromtimestamp()`. These did not affect the
results. No authentication or database implementation changes were necessary.

This verifies the three existing concurrency cases on PostgreSQL, not a load
test or a production verification. Future runs still require explicit approval
of a development database; setting the opt-in flag alone does not establish
that a database is safe to use.

## Separately gated release job

`.github/workflows/saml-postgres.yml` is a manual GitHub Actions job, separate
from the SQLite suite. It does not run on pushes or pull requests. The earlier
approval above is historical evidence, **not approval for this job's target**.

Before enabling it, a repository administrator must:

1. Provision a dedicated non-production PostgreSQL database and test-only role.
   The role needs schema creation permission in that database and must not have
   access to production or shared application data.
2. Create the GitHub environment `saml-postgres-validation`, require reviewer
   approval, prevent self-review where supported, and restrict it to trusted
   release branches. Run only trusted code: tests execute with database access.
3. In that environment, configure the secret `SAML_TEST_POSTGRES_URL` with the
   dedicated `postgresql+asyncpg://...` URL. Never use the application's
   `DATABASE_URL`. Confirm the target's ownership and non-production status
   outside the test; a hostname or `ENVIRONMENT` label cannot prove this.
4. Dispatch **Approved PostgreSQL sign-in validation**, explicitly checking the
   target-approval input, and approve the protected-environment job.

Missing approval leaves the manual job unexecuted; that is **not a successful
release validation**. Missing/invalid configuration after approval fails the
job before any database connection. Only a completed job reporting all three
cases and all teardown phases passed counts as PostgreSQL verification.
GitHub environment protection must be configured by the administrator; the
workflow cannot establish those protections itself.

The same job entry point can be run from `artifacts/api-server/python` on an
approved runner with dependencies installed:

```sh
# Supply SAML_TEST_POSTGRES_URL through the runner's secret store, not the CLI.
ENVIRONMENT=development \
SAML_TEST_POSTGRES_APPROVAL=dedicated-nonproduction \
python validate_saml_postgres.py
```

The runner sets the existing `SAML_TEST_POSTGRES=1` opt-in itself. It selects
exactly `jit`, `transaction_replay`, and `assertion_replay`, rejecting skipped,
missing, extra, failed, or incompletely torn-down cases. It ignores inherited
pytest selection options and application database variables. Raw subprocess
output is discarded: only fixed case names and setup/call/teardown outcomes
are printed. No raw traceback, SQL parameters, captured auth logs, or database
URL is uploaded. A nonzero pytest exit or missing outcome report fails the job.

Each case uses a random disposable schema, with migrations/seeding disabled.
Teardown attempts engine disposal, schema drop and catalog confirmation, then
control-engine disposal, even if an earlier cleanup step fails. Any teardown
failure fails the job. A timeout or forcibly cancelled runner cannot guarantee
cleanup: the job reports this uncertainty on timeout. An operator should check
the **approved dedicated target only** for abandoned `saml_test_` schemas after
cancellation/crash, and remove only schemas verified to belong to the aborted
run. Normal runs are serialized and are not automatically cancelled.

### Verification of the gate

`tests/test_postgres_validation.py` checks approval requirements and rejects
skips, missing phases, failed setup/call/teardown, duplicates, and collection
errors without connecting to PostgreSQL. The default SQLite regression suite
continues to skip the opt-in PostgreSQL cases. These offline checks do not
replace a live approved run of the manual job.