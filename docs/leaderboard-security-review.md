# Leaderboard authorization: rollout gate

## Review request

The top-players endpoint previously permitted anonymous access. This change
requires the existing current-user dependency on `/api/leaderboard`, including
limited queries. `/api/leaderboard/me` retains its existing protection.
Valid active ordinary players retain access; admin privileges are not required.
Missing, invalid, expired, and inactive-user sessions must receive HTTP 401
without player data.

The terminal aliases `leaderboard`, `scoreboard`, and `top` use the existing
interactive Okta sign-in prompt when authentication is absent or rejected by
either leaderboard request. Stale client identity is invalidated, and rankings
are not rendered from partially successful requests. Successful sign-in resumes
the terminal; players can rerun their command.

Player scoreboard reads inspect both request outcomes before rendering or
reporting a non-authentication failure. A 401 from either endpoint takes
precedence over a 503 or network rejection, regardless of completion order:
the expired-session sign-in gate must not be replaced by a stale-score warning.
Synthetic regression cases cover both endpoint assignments and completion
orders for all three aliases.

Review the API router, terminal command handling, auth prompt integration, and
their synthetic-fixture regression tests. No changes to identity provisioning,
SAML validation, session design, scoring, storage, or admin rules are intended.
Previously displayed terminal history is not an authorization boundary.

## Before rollout

- Obtain Security approval and resolve any required remediation.
- Confirm backend and frontend regression suites pass.
- Only then authorize deployment using the normal release process.

## Regression verification — September 22, 2026

**Result: the requested leaderboard regression gate passes.** No application
code fixes were needed. This result is not deployment authorization.

| Check | Command | Result |
| --- | --- | --- |
| Backend regression suite | `cd artifacts/api-server/python && python -m pytest -q` | 54 passed, 3 skipped |
| Frontend regression suite | `pnpm --filter @workspace/fun-with-flags test` | 54 passed across 7 files |
| Frontend type check and production build | `PORT=3000 BASE_PATH=/ pnpm --filter @workspace/fun-with-flags build` | Passed |

Backend coverage includes authenticated ordinary-player access, limited
rankings, personal rank, unranked players, stable ties, and rejection of
missing, invalid, expired, and inactive-user sessions without ranking data.
The full suite also exercises authentication with synthetic SAML fixtures.
Frontend coverage includes all three leaderboard aliases, anonymous sign-in
gating, rejection by either leaderboard request without rendering partial
rankings, stale identity invalidation, successful ranking rendering, the Enter
key input integration, and restoration through the authenticated terminal
event. Popup sign-in polling, blocked-popup retry, cancellation retry, timeout,
and callback handling also pass.

Verification limits and non-blocking observations:

- The three skipped tests are explicitly opt-in PostgreSQL SAML concurrency
  checks in `tests/test_saml_postgres.py`; this run used the suite's isolated
  SQLite fixtures and did not opt into database writes. PostgreSQL concurrency
  is not certified by this result.
- The initial standalone build invocation lacked the required `PORT` setting.
  Supplying command-local `PORT=3000` and `BASE_PATH=/` allowed the unchanged
  build to pass; no workspace or production configuration was changed.
- The backend emitted 131 third-party SAML datetime deprecation warnings.
  Vite reported the existing large HP-UX bundle warning; neither failed a check.
- A development preview screenshot confirmed that the terminal and sign-in
  prompt render. Anonymous requests returned 401 as expected. This was not an
  interactive browser authentication test or a real Okta sign-in.
- No production deployment, production verification, schema changes, or
  production data operations were performed.

The approved leaderboard changes are ready for the normal release
authorization process on the evidence above. Any deployment remains a
separate, explicitly authorized action.