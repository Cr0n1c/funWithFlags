# Matrix reward screen-reader verification

## Outcome — 2026-10-08

User-confirmed working. After being told that actual desktop screen-reader
verification could not be performed in this Linux workspace, the user replied:
“it works”.

This closes the verification request on the basis of user confirmation, not an
agent-observed assistive-technology run. No application changes were made.

## Requested coverage

- NVDA with Firefox on Windows.
- VoiceOver with Safari on macOS.
- Intelligible announcement of the flag and no-time-limit instructions.
- Discoverable **Dismiss reward** button.
- Native text selection and copying.
- A usable, announced empty prompt after dismissal.

The confirmation was general: it did not identify browser, OS, or screen-reader
versions, provide a speech transcript or recording, or give per-check results.
Consequently, this record does not assert independently observed passes for
either combination or any individual check.

## Evidence boundaries

The status markup and browser assertions in
`artifacts/fun-with-flags/src/js/terminal/idleMatrix.ts` and
`artifacts/fun-with-flags/tests/browser/terminal.smoke.ts` are not evidence of
spoken output. They were not rerun as a substitute for screen-reader testing.
Native-phone touch and selection testing is separate and was not performed.
