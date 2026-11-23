# Idle Matrix browser/audio regression checks

## Unlocked replay

Players who have earned the Enter the Matrix points can run `matrix_test` at an
empty prompt to replay the same encounter immediately. The server's solved
record is checked; admin status alone does not unlock it. The command takes no
arguments and does not grant points, submit a flag, or change roles. It will not replace
an active encounter, editor, pager or guided interaction.

Both entry paths are keyboard-only with no buttons. Wrong or out-of-sequence
keys silently return to the prompt. Before a solve, automatic entry occurs after
more than three minutes without a submitted command, when the prompt is safe.
After an awarded solve, automatic entry stops across reloads; manual replay remains.

## Automated checks

Run the focused suite with matching Playwright browser binaries:

```sh
pnpm --filter @workspace/fun-with-flags exec playwright install chromium firefox webkit
pnpm --filter @workspace/fun-with-flags run test:idle-matrix
```

The runner executes Chromium, Firefox and WebKit sequentially and fails if an
engine is missing or a check fails. The general browser suite still defaults to
Chromium. For one engine:

```sh
TERMINAL_BROWSER=firefox pnpm --filter @workspace/fun-with-flags run test:browser \
  tests/browser/terminal.smoke.ts -t 'idle Matrix:'
```

## What is tested

The existing offline terminal fixture builds the real app in memory, uses
synthetic accounts and intercepts every request. Unknown network requests and
WebSockets fail the test. No real API, identity provider, player data or external
audio service is used. Auth/lifecycle test access is appended only to that
in-memory bundle; it is not shipped in the production app.

| Case | Evidence |
| --- | --- |
| Ctrl+X unlock | Playwright keyboard input produces trusted key events; the observer verifies `resume()` occurs **during** Ctrl+X dispatch and the native context reaches `running` |
| Replay gate | Unsolved players, including admins, are denied. Solved nonadmins can replay without waiting. Accepted submission stops idle entry immediately and after reload; extra arguments show usage |
| Escape unlock | Explicitly suspend the same native context, then use a real Escape keypress; verify synchronous resume invocation and return to `running` |
| Five-second delay | Pause JavaScript time between driver calls. At 4,999 ms there is no sound scheduling or reward; at 5,000 ms exactly two oscillators start |
| Maximum in-app volume | Both native gain nodes receive gain 1; the double-knock spacing and stop times are checked. No system/device-volume API is used |
| Audio-node cleanup | Native oscillator completion disconnects both oscillators and both gain nodes |
| Blocked audio | Explicit failure injection: suspended state, rejected resume, and unsupported context construction. All preserve the visual flag, show the unavailable-audio notice, and restore the prompt |
| Completion | The reward and context remain available beyond eight seconds (checked at 30 seconds); Enter or Escape closes the context once and restores a focused empty prompt that accepts real typing |
| Identity boundaries | Sign-out during typing, the delay or the reward cancels old timers/audio without revealing the old flag or reopening sign-in's hidden prompt |
| Account replacement | Refresh the synthetic identity just before the knock; the old context closes and pending callbacks leave the replacement UI untouched |
| Disposal | Repeated installer disposal closes once, cancels sound, removes capture listeners/heartbeat and leaves the prompt editable |
| Pending completion disposal | Hold parsed background/replay responses across repeated disposal, with and without a same-account replacement. Stale work cannot apply status, enter the encounter, or schedule refreshes; the replacement's own status still controls entry |
| Idle eligibility | Guaranteed entry after three command-free minutes for unsolved players; drafts are preserved and a finished pager does not block a later encounter |
| Wrong sequence | Both entry paths silently exit on a wrong key, early Escape, an interrupted Escape pair, or input during the knock delay; no keys leak into shell input |

The three unavailable-audio cases are **injected failure contracts**, not claims
that these engines naturally reject those gestures under their default policy.
The success path uses native AudioContext, oscillators, gains and audio state.
No resume or scheduling implementation is replaced there; the observer delegates
to the browser's native methods.

Completion cleanup cases use an offline-only continuation gate after the real
status service parses its synthetic reply. This models delivery that has already
completed when cancellation occurs; the installer guards, not a rejected fetch,
must discard it. The replacement reply is independently held to expose transient
stale state. Applied-status and finally-block observers prove application-side
settlement, and request counts cover both refresh ticks and the idle deadline.
No live identity, customer API, or award mutation is used in these cases.

## Timing and headless runtime requirements

JavaScript virtual time does not advance Web Audio's rendering clock. Allow real
time for audio state changes and oscillator completion. The five-second puzzle
delay is still checked with exact virtual-time boundaries; audio polling does
not advance the puzzle clock. Freeze the clock at a slightly future instant to
avoid a cross-process `pauseAt` request arriving after its target time.

Use the Playwright version's matching browsers and their native libraries.
`FIREFOX_PATH`, `WEBKIT_PATH` and `CHROMIUM_PATH` can select prepared launchers.
See [CLIPBOARD.md](CLIPBOARD.md) for Nix/GTK/GStreamer constraints. The ignored
local launchers are disposable infrastructure, not portable CI dependencies.
On a supported Linux CI host use Playwright's normal installation.

This workspace's Firefox needed a usable audio destination: without one,
`resume()` stayed pending and native context state remained suspended despite
trusted input. A private, local PulseAudio null sink supplied an audio rendering
destination for the tests. It has no speakers, network listener or external
service and does not change the host's physical-device volume. GTK WebKit ran
under Xvfb with the matching GStreamer plugins and software rendering. The
test-only GTK launcher disables its process sandbox; never use that launcher
for production sessions, customer data or general browsing.

## Evidence and limitations (2026-10-08)

- Chromium: native gesture/resume, scheduling, cleanup, injected failure and
  identity cases exercised in the offline app.
- Firefox 155 / Playwright 1.63: the same native Web Audio and injected failure
  cases exercised using the private virtual audio destination.
- WebKit 26.6 / Playwright 1.63: the same cases exercised in GTK MiniBrowser.

The initial three-engine checks passed before completion changed from a timed
return to explicit dismissal. The current keyboard-only flow and awarded-solve gate
have focused Chromium coverage, but still need a successful three-engine run:
subsequent attempts hit offline page-navigation timeouts before several scenarios
could execute. Type-check passes; do not treat the earlier engine evidence as a
completed validation of the updated dismissal assertions.

These are automated browser-engine results, **not** evidence of audible
physical-device playback, shipping macOS Safari, iOS Safari, device mute
switches, Bluetooth routing, perceived loudness or speaker quality.

For a separate physical-device check, use an isolated synthetic session:
complete Ctrl+X then two Escapes, confirm the knock follows the displayed
message by five seconds, and confirm the reward remains readable if browser
audio is disabled. Keep the device at a comfortable user-selected volume;
the application must never raise system volume. Record browser/OS, output
device, audible result and blocked-audio feedback separately from automation.
