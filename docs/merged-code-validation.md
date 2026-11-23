# Combined-code validation after merges and before deployment

The configured `scripts/post-merge.sh` preserves the locked pnpm dependency
installation and then calls `bash scripts/validate-merged.sh`. A failure exits
nonzero immediately, with the failed stage and compiler/import traceback in the
post-merge output. Do not
deploy until the failure is fixed and this check passes.

Run the same check manually from the repository root:

```sh
bash scripts/validate-merged.sh
```

The named `merged-code` validation uses this same command. The separate
`merged-code-regressions` validation exercises the validator itself:

```sh
python -m unittest discover -s scripts -p 'test_validate_merged.py' -v
```

## Coverage and safety

- Forced Python compilation covers the API package, including routers, tests,
  migrations, and launch scripts. A stale bytecode cache cannot conceal a syntax
  error.
- A separate Python process receives an empty environment and uses only synthetic
  production-mode settings. It exercises launcher configuration, the real ASGI
  entrypoint, router imports, application lifespan, in-process `/api/health`,
  and shutdown.
- The real database constructor and teardown run. No database connection, migration, seed, real
  SAML login, or external API request is part of this check. Python audit guards
  reject network connections, DNS, socket binding, and subprocess launches, and
  fail the check even if application code catches the rejection.
- Frontend validation explicitly invokes `@workspace/fun-with-flags`'s
  `type-check` script. The workspace recursive `typecheck` command alone skips
  this differently named imported script.
- Python has a 45-second overall limit (30 seconds per child); frontend
  typechecking has a 60-second limit. Offline Chromium terminal checks have a
  240-second overall limit, with a 10-second forced-kill grace period.
  The post-merge hook allows 600 seconds including dependency setup (the stage
  limits total 355 seconds, leaving 245 seconds for setup and overhead).
  It creates no additional service or workflow.

## Deployment build gate

The deployment build must run
`bash scripts/validate-merged.sh` before artifact-specific production builds.
This checks the source being deployed, including direct edits made after a
merge. A Python compile/import/startup failure, frontend type error, or browser
test failure exits nonzero and stops the build; fix the reported stage before
trying again. A browser timeout also blocks the build.

The artifact build commands remain unchanged: API Python compilation and the
frontend production bundle still run after this gate succeeds. The existing
post-build pnpm store pruning also remains unchanged. The gate relies on the
build environment's installed Python and pnpm dependencies; missing dependencies
fail the build rather than bypassing validation.

The synthetic startup retains its empty child environment, network/process
guards, disabled refresh scheduler, and forbidden migration/seed operations,
even when the build environment provides production settings. No production database is
accessed by this check. Production schema changes remain governed by the
deployment policy, not this script.

This gate does not replace database readiness, migration verification, approved SAML integration
testing, frontend bundling, or a production deployment check. It never grants
permission for those live operations.

## Offline browser terminal smoke check

This mandatory check runs after typechecking in `validate-merged.sh`, so the deployment build,
post-merge setup, and the named `merged-code` validation all execute it.
To run just the browser stage locally, from the repository root:

```sh
pnpm --filter @workspace/fun-with-flags run test:browser
```

It reuses the frontend's Vitest runner and shared synthetic account fixture, but
executes the production JavaScript bundle in Chromium rather than Node. The
ordinary `test` script remains the fast Node unit suite.

### Diagnosing offline browser startup

Shared setup and teardown emit `[offline-shared-hook]` JSON before navigation
diagnostics are available. The fixed phases are `build` (including temporary
directory creation), `assets` (in-memory asset preparation and fixture checks),
`browser-launch`, `browser-close`, and `scratch-cleanup`. Each phase emits a
`started` record, at most three `pending` records at ten-second intervals, and
one `completed` or `failed` record if the operation settles. Each line contains
only the phase, outcome, capped integer `elapsedMs`, and, on failure, a
`timeout`/`error` classification. No bundle contents, browser arguments, paths,
environment values, raw errors, or credentials are logged. Vite's own build
logging is suppressed, and caught exceptions are replaced without a raw cause.

A last `started`/`pending` record identifies the active shared operation; it
does not prove the cause of a stall. The immediate start record also survives
an operation that blocks Node's timers. Reporting timers are unreferenced,
cleared on settlement, and stop after their third pending record even if a hook
never settles. Browser shutdown and temporary-directory removal start
independently, so a stuck or failed close cannot skip directory removal.
Cleanup failures still fail the hook. The existing 60-second hook deadline,
offline restrictions, in-memory build, ephemeral environment directory,
production bundle transforms, suite watchdog, and concurrency policy remain
unchanged.

The terminal fixture emits `[offline-startup]` JSON when startup fails or takes
at least ten seconds. It emits at most three progress records and one final
record per fresh context. Fast successful starts are normally silent; to include
their timings in an isolated diagnostic run:

```sh
SMOKE_STARTUP_DIAGNOSTICS=1 pnpm --filter @workspace/fun-with-flags run test:browser
```

Do not overlap this with a running release workflow. This option only enables
logging: it does not retry tests, change timeouts, reuse contexts, or enable
network access. Navigation still waits for the original `load` event with a
30-second deadline; actions remain bounded at eight seconds, and terminal
readiness retains its separate existing deadlines.

Reports contain only fixed startup phases (`context`, `routes`, `page`,
`navigation`), elapsed times, fixed browser lifecycle milestones, Node scheduler
lag, and aggregate counts/timings for fixed resource categories. They never
include URLs, request or response bodies, headers, browser console text, raw
errors, environment values, DOM content, storage, transcripts, or screenshots.
Even unknown resource types map to `other`, rather than becoming report keys.
Startup exceptions are replaced with a fixed phase and `timeout`/`error`
classification; the raw exception is deliberately not attached as a cause.
Listeners and the sampling timer are removed on success or failure.

Interpret the evidence before applying a workaround:

- `context` or `page` without document requests points to browser/context
  startup, before the fixture served the document.
- A nonzero `routing` count means an intercepted route handler is still pending;
  `maxRouteMs` measures completed handlers, including file reads and fulfillment.
- Completed routes without finished requests or lifecycle events distinguish
  browser-side processing from a still-running fixture handler. A DOM-ready
  milestone without `load` narrows the stall to the remaining load work; it does
  **not** prove a particular asset, decoder, or renderer is responsible.
- A large `maxSchedulerLagMs` shows delayed Node timer scheduling, not proof of a
  specific competing process. Low lag does not rule out browser CPU contention.
- `crash`, `close`, and `disconnected` are fixed milestones, never raw crash logs.

Reports are read from events already received by Node. They do not evaluate
JavaScript inside a potentially hung renderer or extend its deadline to collect
diagnostics. A successful local run is not evidence that a historical build
timeout has been fixed. Preserve a failing run's bounded records before deciding
whether the fault is routing, browser startup, load processing, or scheduling.

#### Investigation evidence (2026-10-08)

The failed deployment builds created on October 7 at 18:44 UTC and October 8 at
20:07 UTC recorded `page.goto: Timeout 8000ms exceeded` while waiting for `load`
at the synthetic origin. The former included the unrelated admin-import cases.
Those builds predated the current explicit navigation deadline: navigation was
inheriting the action deadline. The current 30-second navigation setting was
already present before this diagnostic work and is preserved, not increased.

A controlled offline Chromium experiment held a single synthetic document route
for nine seconds, using fresh contexts and no external requests. With the old
action-only configuration it failed at 8,003ms. With the current timeout helper it
loaded at 9,077ms. Both scenarios made exactly one navigation attempt. This
reproduces the timeout-policy failure without retries or real network access; it
does not establish why a specific historical load was slow.

The diagnostic full offline suite passed all 85 tests in 413.36 seconds, with 83
terminal contexts taking 227–1,060ms to start. Maximum observed Node scheduler lag
was 4ms; maximum completed route-handler time was 322ms. No navigation stall,
browser crash, or persistent slow asset reproduced locally. Historical logs did
not include per-resource startup evidence, so a particular renderer, asset, or
resource-contention cause cannot responsibly be assigned to the old delays.
The new bounded reports provide that distinction if a future run stalls.

### Browser prerequisites

Prerequisites are the locked pnpm dependencies and a Chromium executable.
Set `CHROMIUM_PATH` to use a system browser. Otherwise
install Playwright's browser once (this setup step requires network access):

```sh
pnpm --filter @workspace/fun-with-flags exec playwright install chromium
```

Alternatively set `CHROMIUM_PATH` to an existing compatible Chromium executable.
Missing browser dependencies fail the check; they do not silently skip it.
Provision these prerequisites in every build environment before releasing.
The gate never downloads a browser or repairs dependencies automatically.
Inspect build-stage logs for the explicit offline Chromium result; runtime startup
logs or a successful deployment alone do not prove that this gate ran.

The check:

- Builds assets in memory with an isolated, empty environment-file directory;
  it does not overwrite `dist`, start a web/API server, or read workspace `.env`
  files. It does not need `PORT`, `BASE_PATH`, SAML credentials, or a database.
- Fulfills browser requests directly from built assets, local public files,
  synthetic authentication/home-roster/challenge responses, and empty font CSS.
  Unexpected requests and WebSockets are blocked and fail the check. No route
  passes requests through to the network.
- Uses fresh nonpersistent browser contexts and closes them on success or
  failure, discarding cookies, localStorage, and IndexedDB. It never uses a
  developer's browser profile.
- Checks signed-out gating, signed-in startup, and real terminal input/output
  for `pwd`, `whoami`, `id`, `uname -a`, lazy `hostname`, pipelines through
  `tr` and `wc`, and `challenges gold`. It fails on uncaught browser exceptions,
  unexpected console errors, missing output, or stalled command completion.
- Allows up to 60 seconds for bundle/browser setup and 45 seconds per test,
  including the real startup animation. A normal run takes roughly 25 seconds.
  The release gate additionally bounds the entire command to 240 seconds,
  including all tests and cleanup, and force-kills it after 10 further seconds
  if necessary. Reassess this total budget when expanding browser coverage.

To prove that a bundle-success/browser-runtime failure is caught:

```sh
SMOKE_INJECT_MISSING_GLOBAL=1 pnpm --filter @workspace/fun-with-flags run test:browser
```

**This command must fail.** A test-only build plugin injects a reference to
`__FWF_MISSING_BROWSER_GLOBAL__` into the lazy shell module. Compilation still
succeeds, but Chromium reports a `ReferenceError` and Vitest exits nonzero.
No source or production bundle is modified; omit the variable for a normal run.
Both the normal pass and this deliberate failure were verified.

This is representative smoke coverage, not exhaustive coverage of every shell
command, browser engine, persisted-home migration, or real SAML/backend behavior.

Regression tests use disposable source copies to confirm rejection of unfinished
imports, missing imported names, startup failures, and caught outbound calls.
They also verify that hostile parent runtime/database settings are ignored.
Build-gate wiring tests run the build command and verify success
and failure propagation with disposable stub executables, including that a
Python failure prevents frontend validation, type errors prevent browser tests,
and browser failures, missing prerequisites, and timeout exit codes block the
gate. They also check that post-merge uses the same gate with sufficient time.
No test deploys the application.