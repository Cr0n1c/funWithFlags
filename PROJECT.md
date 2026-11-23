# Fun With Flags

Imported from https://github.com/Cr0n1c/funWithFlags. Preserve the original CRT terminal, browser Unix sandbox, and FastAPI behavior. Authentication is Okta SAML 2.0.

## Run & Operate

- `python artifacts/api-server/python/run_server.py` — API launcher; requires `PORT` and `APP_BASE_URL`
- `pnpm --filter @workspace/fun-with-flags run dev` — frontend managed workflow
- `cd artifacts/api-server/python && python -m app.cli migrate` — development-only Alembic migration
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Run locally

Needs Python 3.13 with `uv`, Node 22.12+ with `pnpm`, and a PostgreSQL database.

```sh
pnpm install --frozen-lockfile
createdb funwithflags

# API (terminal 1)
cd artifacts/api-server/python
export ENVIRONMENT=development PORT=8000 LOG_JSON=false
export APP_BASE_URL=http://localhost:5173 SESSION_COOKIE_SECURE=false LOCAL_DEV_LOGIN=true
export SESSION_SECRET=$(openssl rand -hex 32) FLAG_HASH_SECRET=$(openssl rand -hex 32)
export DATABASE_URL=postgresql://localhost/funwithflags
uv run python -m app.cli migrate
uv run python -m app.cli seed challenges.example.yaml   # optional sample challenges
uv run python -m app.cli serve

# UI (terminal 2, repository root)
PORT=5173 BASE_PATH=/ API_PROXY_TARGET=http://localhost:8000 \
  pnpm --filter @workspace/fun-with-flags run dev
```

Open http://localhost:5173. Keep `FLAG_HASH_SECRET` stable between runs or stored flag
hashes stop matching.

`LOCAL_DEV_LOGIN=true` makes the sign-in action log in a fixed "Local Developer"
administrator account without an identity provider. The API refuses to start with it
unless `ENVIRONMENT=development`, `APP_BASE_URL` is a localhost origin, and no SAML
issuer or SSO URL is configured. With the flag on, the API listens on 127.0.0.1 only and
ignores forwarded-address headers; the handler rejects requests that carry them or use a
non-localhost Host, and the dev server listens on loopback whenever it proxies. Never
set it on a shared or deployed environment. Real sign-in is Okta SAML and requires an
HTTPS origin plus the `SAML_*` variables in `artifacts/api-server/python/.env.example`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Active API: upstream Python 3.13 FastAPI in artifacts/api-server/python
- Active DB models: SQLAlchemy and Alembic in that Python package
- Original vanilla TypeScript + SCSS terminal hosted in the Vite web artifact
- Express/Drizzle shared scaffolds are unused by this imported product; do not push the empty Drizzle schema over the imported database.

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- Development/production parity is a completion requirement for every feature. Include production-compatible dependencies, configuration, routing, persistence, authorization, and any required content/data provisioning—not just a working preview. Features needing initial records must have an explicit, authorized, repeat-safe production path as part of the same delivery; development-only seeding is not sufficient.
- Validate production build/runtime assumptions before delivery and distinguish implemented, deployed, and live-verified status. Identify required environment-specific setup and remaining activation steps explicitly. Do not imply deploying code copies development records into production.
- Parity does not mean shared data or relaxed safeguards: keep environments isolated, preserve production users/scores, never copy development data wholesale, and retain explicit admin confirmation for data mutations. Deployment remains user-initiated; existing Security approval boundaries and the prohibition on startup migrations/seeding remain in force.
- User chose full CTF with a separate development database and most recently requested Okta SAML sign-in, superseding the previous OIDC direction. Never connect to or migrate the original production database.
- Preserve the existing upstream API contract and client instead of replacing it with generated React hooks.
- No startup migrations or seed operations: use the development-only CLI; production schema changes are a separate, reviewed deployment step.
- Runtime mode is fail-closed: `ENVIRONMENT` accepts `development`, `production`, or `test`; when unset, `NODE_ENV` accepts the same values and supplies the mode. Conflicting signals are rejected, and a standalone process with no signals defaults to development. Production must set `ENVIRONMENT=production` explicitly.
- Deployment-specific values are never hardcoded. The app origin (`APP_BASE_URL`), the IdP SSO URL (`SAML_IDP_SSO_URL`), the IdP and SP entity IDs, the ACS URL, and the IdP certificate are all read from the environment; `artifacts/api-server/python/.env.example` lists them. The launcher never infers `APP_BASE_URL` and always uses HTTPS, Secure cookies, and no startup migrations or seeding. Production Settings requires a public HTTPS origin and rejects localhost and loopback.
- Secure, HttpOnly, SameSite=Lax sessions remain intact. The most recent requirement supersedes the popup preference: sign-in starts only from an explicit “Sign in with Okta” action, navigates to Okta in the same window, and resumes the shell after the callback checks the session once. Startup and callback errors must never automatically launch or retry sign-in; legacy popup callback URLs are normalized into this same-window flow.
- Initialize authentication before booting the shell. `/api/auth/home-roster` is the minimal authenticated source of truth for simulated homes: it returns the current immutable database account ID and canonical home plus home paths for active SAML accounts that have logged in. It must not expose email, departments, groups, or Okta subjects. Canonical home names are permanently allocated normalized labels in account-creation order: the first gets the bare name, later collisions get `-2`, `-3`, etc. System names are reserved and deleted accounts' names are not reused. Profile changes do not rename an allocated home; immutable account IDs remain the security boundary.
- The browser Unix filesystem remains private browser storage and is never uploaded. Lifo IndexedDB databases are scoped by immutable backend account ID, and the permission overlay denies traversal, reads, writes, redirects, editor saves, copies, and moves involving another roster home. `/home` itself remains listable. Do not key access or persistence by a display name.
- User confirmed Security approval for the stable shell-name/home-rename change on 2026-09-23. Existing homes may move only inside the same immutable-account browser database with a matching account ownership marker. Never merge or overwrite a destination; invalid markers and filesystem failures stop migration explicitly. This approval does not authorize unrelated SAML trust changes or live IdP testing.
- Keep the existing `hpux-tree-v1` seed marker: filesystem updates must be surgical and non-destructive. Removed historical sample accounts/homes are stripped from fresh seeds; preexisting sample home/crontab data is quarantined outside `/home` rather than discarded, exact account records are removed, and the empty Lifo-generated `/home/user` is removed only when empty. Never claim legacy name-only personal data for a new account; an un-attributable legacy Lifo database remains untouched rather than leaking across same-name identities.
- Historical users/scores remain unchanged. Okta SAML accounts are created just in time from a validated stable subject and are never linked by email or display name. Pre-SAML sessions must not grant access after cutover.

## Product

- Curl allows one in-flight request and ten admitted attempts per rolling minute per authenticated account, returning 429 with `Retry-After` on excess. Like the four-fetch global cap, quotas are per API process, reset on restart, and are not shared across replicas. Offline IMDS remains simulated; its requests count toward the account quota. Quota state is memory-only and contains no URLs or response content.

- HP-UX mail is a private browser-only Lifo file at `/var/mail/$USER`, with a mode-600 canonical account mailbox and the unchanged `/var/mail` directory permissions. The authenticated `/api/challenges/notifications` feed pages committed flag audit attempts by immutable event ID. On first setup it records a watermark instead of replaying historical scores; later request-owned checks catch up events after offline periods. A browser account-ID-scoped delivery cursor is independent of the mailbox: truncating, editing, or removing mail never changes points or replays old notifications. Both submit paths use the same submission service and the mailbox check, with no submitted flag in notification bodies. A failed mail check warns separately without changing the committed scoring result. The terminal output finalizer leaves one blank line before the next prompt, including paginated results.
- Optional Slack activity notifications use environment-scoped `SLACK_ACTIVITY_WEBHOOK_URL` (a Slack HTTPS incoming webhook at `hooks.slack.com/services/...`), held as `SecretStr`; leave unset to disable. Only committed first positive flag awards and verified committed SAML callback logins enqueue durable safe one-line messages in `activity_outbox`; ordinary authenticated top-level terminal commands send one allowlisted name (unknown shell input becomes `shell command`) via `/api/activity/command`, with no arguments or guided input. Command events are best-effort only and limited to 10 per account per minute. Scoring/login enqueue and delivery are request-owned and fail open after commit; next eligible activity request drains one due event. Delivery retries exponentially and is at-least-once: a lost Slack acknowledgement can duplicate a message. Missing outbox schema disables durable notifications without disabling scores/login; run the development-only Alembic migration explicitly in environments requiring it, and apply production schema separately, without startup DDL or data seeding. Never log webhook URL or HTTP exceptions, include secrets/flags/ticket content, or run live Slack submissions in tests.

- Degauss frequency (last trigger and count) is saved in browser localStorage, scoped by immutable account ID when signed in or a browser-only fallback when signed out. It survives reloads on this browser but does not sync across devices; no server-side preference or identity data is stored.

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

- Keep ordinary terminal output, scoreboards, tables, and prompts consistent in font and theme color wherever possible. Preserve meaningful distinctions for links, errors, and interactive states without switching table output to a visibly different typeface.

## Gotchas

- The Linear integration and the Blue and Red scoring tracks were removed. Alembic history is a single revision, `0001`, that creates the current schema on an empty database; there are no incremental migrations. A database stamped with an older revision cannot be upgraded by Alembic and still holds the removed tables. A deployment may apply schema without data migrations, so startup repairs any projection row whose totals disagree with the solve and group-credit ledgers.

- Curl release safety: the default `scripts/validate-merged.sh` release gate and `python scripts/validate-python.py` run the complete synthetic `test_public_curl.py` suite. `python scripts/validate-python.py --curl` runs it alone with a 180-second deadline and process-group cleanup; `--setup-only` explicitly omits it. Both pytest and its exec workers deny live DNS/network operations, non-memory SQLite, dotenv reads, and unapproved processes, with no inherited credentials or pytest overrides. All collected tests and pinned safety cases must pass with zero skips or blocked attempts. Safeguards: `python -m unittest discover -s scripts -p 'test_validate_public_curl.py' -v`. This is offline regression evidence, not a live network or application database check.

- Scoreboard recovery concurrency: `python scripts/validate-scoreboard-concurrency.py` runs the scoreboard suite against a disposable local PostgreSQL cluster with synthetic records, no inherited credentials, no TCP listener, and external networking blocked. It requires all twenty PostgreSQL contention cases to pass with zero skips, including confirmed flag deletion in both commit orders from empty/partial projections, plus pre-commit exception and task-cancellation rollback while recovery waits. Writer interruption cases verify original source records, prior scores, absence of removal audit events, and advisory-lock cleanup; cancellation must propagate to the writer's caller. Waiting-recovery cancellation cases cancel either queue position, require cancellation to propagate before the writer is released, confirm the writer's locks and other recovery worker remain intact, and verify committed ledger totals, audits, idempotence, and lock cleanup. Partially locked recovery cases prove player keys are already held while waiting behind a group-only writer, then cancel recovery and require a queued player writer to commit before releasing the group writer; surviving recovery must finish with ledger-correct scores and no remaining advisory locks. Flushed-recovery cancellation cases interrupt after both projections reach PostgreSQL but before commit, verify complete rollback and preservation of prior player/group rows before retry, then require ledger-correct, idempotent recovery and lock cleanup. Missing binaries fail explicitly. Runner safeguard checks: `python -m unittest discover -s scripts -p 'test_validate_scoreboard_concurrency.py' -v`. This is local regression evidence, not live database or deployment verification.

- Required secrets include SESSION_SECRET and FLAG_HASH_SECRET, at least 32 characters each. Never print values. Okta SAML trust material and service-provider settings must be configured through the backend's documented environment contract; do not guess key names or place sensitive material in frontend configuration.
- Use the same unprefixed SAML variable names in separate development and production environment scopes. Deploying requires explicit Okta SAML service-provider and identity-provider configuration for the production origin. Development and production must use distinct app registrations, entity IDs, assertion-consumer URLs, administrator-provided metadata, and trust.
- An IdP signing certificate is non-secret public trust material. SP private keys, session/flag secrets, and credentials are sensitive and belong in environment-scoped Secrets; an SP public certificate is not secret. Do not move, replace, or otherwise change current trust material without authorization.
- Active and rollover signing certificates in one scope must belong to the same IdP registration, never the opposite environment. SAML identities are issuer-qualified and are never auto-linked across registrations, even when subjects or profile fields match.
- Deploying requires explicitly configuring the real production APP_BASE_URL; do not reuse the development origin.
- Restart API workers after environment or SAML configuration changes so cached settings and trust are reloaded.
- Rollout has two separate gates: Security approval through your internal Security review process, and specific authorization for the real same-window login checklist (login/callback, private-gate ACS POST, profile refresh, disabled account, logout, and score checks). The group-authorization approval below does not by itself authorize the live-login checklist.
- Exact `funwithflags-admins` membership from a validated, issuer-qualified Okta SAML login grants full app-administrator access. The owner confirmed Security approval for this broader policy on 2026-10-08. The existing explicit Okta-subject allowlist remains an additional general-admin path; flag mutations still require verified group membership. Derive group authority from the current stored validated profile, not a sticky administrator bit. Membership changes in Okta take effect when a new SAML login refreshes the profile; the app does not poll the Okta directory.
- The terminal `groups` command shows the current user's Okta SAML memberships, not simulated Unix groups. If no memberships are supplied, report them as unavailable rather than inferring them.
- The private account status may show validated email, first name, last name, department parent, department leaf, and level attributes. These attributes are not authorization or account-linking inputs and must not appear on shared leaderboard surfaces.
- Upstream example challenges include a nonexistent external target; do not activate that target as a working challenge.
- Group scoring is an immutable award ledger: a user's first correct solve credits each distinct, trimmed, non-empty group in their stored validated IdP profile at most once per challenge. Group names remain case-sensitive. Repeat solves and later membership changes never alter awards, and historical solves are not backfilled because their identity-group provenance is unavailable. Deleting a user nulls credit provenance rather than deleting earned group points.
- Confirmed flag deletion intentionally removes all personal solves and group credits for that flag, reducing both leaderboards. The terminal must show its title and point value and request explicit confirmation first. Hidden gold flags remain claimable but expose `<hidden>` rather than their title on public challenge views.
- `/api/leaderboard/groups` aggregates only the group credit ledger and exposes group name, score, solve count, award time, and rank to authenticated users; it never derives scores from current memberships or exposes private profile attributes.
- Crack The Hash puzzles use the `cracking` category. To reclassify existing records without reentering original words, startup runs one atomic, idempotent data-only UPDATE matching the three exact puzzle fingerprints (slug, title, points, description, active, visible, case-insensitive, old Gold category). IDs, flags, solves, scores and unrelated Gold rows are untouched. No startup DDL, seeds or record creation are enabled, and development data is not copied to production.
- `import_challenges` is the one confirmed, atomic admin import for missing built-in hash and planted terminal challenges. Its server preview returns only missing metadata; it requests original words only for missing hash puzzles, and imports missing terminal challenges without word prompts even if all hash puzzles exist. Both preview and import require exact validated `funwithflags-admins` membership. Gold track displays the union of Gold, OWASP and Cracking records without changing their stored categories; bare `challenges` shows each row once. Neither import copies development records into production or runs on startup: an approved group member must explicitly run the command in each environment after deployment. Existing challenge IDs and score ledgers remain unchanged.
- `export_flags` downloads a private version-1 JSON backup of challenge metadata and HMAC flag hashes (no plaintext, IDs, user information or score data); treat the downloaded file as sensitive and store/transfer it securely. `import_flags` selects a local JSON file, previews missing/identical/conflicting records, then explicitly confirms missing-only import. The API requires exact validated `funwithflags-admins` membership on export, preview and commit. The `key_id` is a domain-separated HMAC under `FLAG_HASH_SECRET`; imports require the same secret as the source or they fail closed. Use environment-scoped secrets; do not copy the secret just to make unrelated environments compatible. Backups are bounded to 1 MiB and 1000 challenges; existing differing slugs or reused hashes abort the entire transaction without overwriting existing IDs, solves or scores. No backup operation runs on startup.
## Pointers

- The existing repeat-safe category normalization also reclassifies the exact legacy “Find the undocumented command” built-in from `gold` to `OWASP`. It preserves IDs, flags, points, solves and awards; startup applies this data-only correction without an import or schema migration.

- Slack activity delivery additionally requires the independent, default-off `SLACK_ACTIVITY_ENABLED` opt-in. Configuring the webhook alone does not authorize player activity exports. Leave this off unless the operator separately approves activity delivery; disabled activity does not enqueue or drain messages.

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
