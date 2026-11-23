# Offline browser fixture timing

Run the complete configured suite, without another release workflow running:

```sh
BROWSER_FIXTURE_TIMINGS=1 timeout --kill-after=10s 900s \
  pnpm --filter @workspace/fun-with-flags run test:browser
```

This is opt-in diagnostic output, not a new pass/fail threshold. The release
script's existing deadline, individual test deadlines, readiness waits and
navigation timeouts are unchanged. Do not run a second copy alongside the release
gate: resource contention makes timing comparisons unreliable.

The fixed-label summaries contain counts and elapsed seconds only:

- `bundle` and `browser`: one build and browser launch per file.
- `context`: creating the new context, routes and page per terminal case.
- `navigation`: initial fixture navigations, not reloads exercised by assertions.
- `ready`: waits for the real shell's editable, non-busy prompt.
- `journey`: terminal callbacks, including assertions and any setup they perform.
- `teardown`: destroying each terminal context.
- `documents`: terminal page load events, including intentional reloads.

These are **nested**, not additive: `ready` occurs inside `journey`, and deferred
initial `navigation` does too. Use Vitest's total duration for wall-clock
comparisons and its existing per-test durations to locate costly cases. No
transcripts, network payloads, URLs, account data or environment values are added
to timing logs.

## Safe setup reuse

The app bundle and public asset bytes are immutable within a file's run, so the
fixture can reuse them. Every case still gets a fresh browser context and fresh
synthetic session, with service workers blocked, HTTP requests intercepted and
unexpected HTTP/WebSocket traffic rejected. No browser storage or authenticated
state is shared.

Matrix clock/audio observers and synthetic admin identities can be installed
before the **first** navigation. An initial boot followed by a setup-only reload
does not add coverage. Persistence, identity transitions, permission changes,
clipboard settings and reload-geometry cases still perform their real reloads.
Welcome-only acceleration remains narrowly scoped; command animations, native
audio, lifecycle timing and geometry assertions are unchanged.

## Measurement evidence (2026-10-08)

Both full runs passed the same 85 cases across all three configured files.

| Coarse measure | Before | After |
| --- | ---: | ---: |
| Full suite wall time | 417.70 s | 374.91 s |
| Terminal contexts created/destroyed | 83 / 83 | 83 / 83 |
| Terminal documents loaded | 151 | 101 |
| Terminal prompt-readiness calls | 146 | 99 |
| Time inside terminal readiness waits | 52.2 s | 32.4 s |
| Total bundle-build time, all files | 2.4 s | 1.5 s |
| Total browser-launch time, all files | 1.8 s | 1.4 s |

The deterministic reduction is **50 fewer document loads** and **47 fewer
readiness calls**, not fewer cases or contexts. Bundling was not the dominant
cost, so builds/browser lifetimes were not consolidated across files.

Timing caveat: a configured release workflow started partway through the
baseline. An initial after-run was stopped when that overlap was detected; the
completed after-run waited until the release workflow finished. Thus the
42.79-second wall-time difference is approximate, not a controlled speedup
estimate. The overlapping release run itself also passed all 85 cases in
391.95 seconds. No timing threshold was weakened or added.
