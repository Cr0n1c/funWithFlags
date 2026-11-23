# Native Chromium zoom: pager journey complete, desktop-media verification limited

Recorded on 2026-10-08. **User-approved closure; not a passing readability test.**

## User acceptance

On 2026-10-08, after the observed failures and verification limits were reported,
the user explicitly approved closure: “i sign off that this is g2g”.
This accepts the documented outcome and waives further native-browser
verification as a requirement for closing this task. It does not establish
that the user performed additional testing.

The measured failures, unavailable Firefox/Safari/text-only checks, unverified
hover-capable desktop layout, and code-snapshot limitation below remain
unchanged. No new browser tests or application fixes accompanied this sign-off.
The separately proposed robustness and visibility-check work remains separate
from this acceptance.

## Code snapshot

Browser evidence was captured against application revision `339f3ae`, before
syncing this report with the newer main branch. That sync included subsequent
pager keyboard-focus/horizontal-navigation changes (`f54e466`); this report
does not claim to verify those later changes. The screenshots and raw results
are retained as evidence of the tested revision, not regenerated results.

## Verdict

The bounded pager journey completed at genuine native Chromium page zoom of
200% and 400%, including live OS window resizing, row/page advancement,
horizontal table scrolling, all three exit routes and immediate commands, and
reset to 100%. Results are recorded per check in `measurements.json`, including
failures; no application source was changed.

This run cannot establish the intended *hover-capable desktop* result: headed
Chromium reported no hover-capable or fine pointer (`hover`, `pointer`, `any-hover`,
and `any-pointer` all false), despite `navigator.maxTouchPoints === 0`. Hover
emulation was not used. The no-hover profile prevents the app's desktop-only
pager/hardware rules from activating. The observed overlap/clipping below is
real in this browser session, but is not evidence that the hover-capable desktop
branch fails. A true hover-capable browser session is still needed to close that
verification gap.

## Environment and preview/CSS check

- Ubuntu 24.04.4 testing host; headed Chromium 152.0.7977.64.
- Baseline at native 100%: content viewport 1280×900 CSS px, outer window
  1288×991, DPR 1. Pager content font remained 20px.
- Firefox was unavailable; Safari was unavailable (WebKit is not claimed as
  Safari). Chromium exposed page zoom, not a separate text-only zoom control.
- The preview's loaded inline stylesheet text does contain the relevant
  `.switch-mount`/`.degauss-mount` visibility rules under
  `@media (hover: hover)`, and the fixed/inset pager rules under
  `@media (hover: hover) and (max-height: 600px)`. These match the checked-out
  `artifacts/fun-with-flags/src/sass/terminal.scss` rules at lines 392–430.
  Thus the relevant CSS is present in the tested preview; stale/missing CSS is
  not indicated. The first CSSOM walker did not enumerate nested rules, so the
  raw JSON also records direct loaded-style-text checks.
- Browser media features: `(hover: hover)`, `(pointer: fine)`,
  `(any-hover: hover)`, `(any-pointer: fine)` all `false`; max touch points `0`.
  No hover emulation or CSS injection was performed.
- At 200% and 400%, computed `.switch-mount` and `.degauss-mount` were both
  `visibility: visible`, `display: block`, `position: fixed`; the active pager
  was `position: static` with `inset: auto`. This is consistent with the loaded
  CSS's hover condition not matching this browser's reported media features.
- All API traffic used an offline synthetic fixture: one synthetic user and 80
  wide rows. Activity requests were intercepted; no live scoring or database
  writes occurred. No unexpected API paths were observed.

## Per-check results

### Native zoom and live OS resizing

| Check | Observed |
|---|---|
| 200% | Native Chromium menu read 200%; viewport 640×450, DPR 2; outer window remained 1288×991. |
| Resize while pager open at 200% | OS window 1208×931; viewport 600×420, DPR 2. Restored to baseline window afterward. |
| 400% | Native Chromium menu read 400%; viewport 320×225, DPR 4; outer window remained 1288×991. |
| Resize while pager open at 400% | OS window 1208×931; viewport 300×210, DPR 4. |
| Reset | Chromium returned to native 100%; viewport 1280×900, DPR 1. Ordinary-layout screenshot saved. |

### Pager status and hardware

- At 200%, status text was correct and its 20px line fit in the 313px-high pager
  viewport. In the final saved run, status glyph center hit-tests were intercepted
  by `.scanline`; a preceding bounded run passed this check, so the result was
  not stable across runs. Its status bounding box was y=351.56–371.56; the fixed
  Degauss control began at y=365.02, so their rectangles overlap by about 6.5px
  near the right side. During live resize, the pager viewport was 530×273, the
  status wrapped to 40px high, and the Degauss control began at y=335.02.
- At 400%, status text was correct and a 20px line fit in the pager viewport
  (96px at the initial viewport, 76px during live resize; the wrapped status
  box was 60px high). The fixed Degauss control occupied y=140.02–219.98 at
  the initial viewport and y=125.02–204.98 during live resize. Hit testing
  found the Degauss label over status glyphs, including `Q/Esc`, during both
  native and resized states; other glyph centers hit `.scanline`. The 400%
  screenshot shows the hardware over the pager/status area.
- These overlaps were observed before drawing a conclusion about cause. The
  loaded desktop rules are present, but the browser's false hover media query
  means those rules were not active. Per the test constraint, hover was not
  emulated; behavior with a true hover-capable desktop pointer remains
  unverified.

### Paging, table scrolling, exits, and immediate commands

- `Enter` advanced exactly one 20px row at both zoom levels.
- `Space` matched the actual `PageCursor` page movement, not
  `viewport.clientHeight`: 200% moved 320px = 16 rows × 20px; 400% moved 100px
  = 5 rows × 20px. The earlier client-height-based assertion was incorrect;
  source inspection and the corrected measurements confirm the pager behavior.
- Horizontal table scroll at 200%: `scrollWidth` 1548, `clientWidth` 569,
  rightmost `12345` visible at `scrollLeft` 979; reset to `scrollLeft` 0.
  Status bounding box stayed stationary.
- Horizontal table scroll at 400%: `scrollWidth` 1548, `clientWidth` 256,
  at maximum `scrollLeft` (1292.25), the final saved run did not find the
  rightmost `12345` fully visible/hit-testable; a preceding bounded run did.
  Status bounding box stayed stationary in both. The differing hit-test result
  is consistent with the fixed hardware overlapping the narrow table viewport;
  it was not stable enough to attribute solely to table overflow.
- Q, Escape, and natural end all closed the pager at both zoom levels. For each
  exit, the immediate command was typed without clicking/refocusing and
  completed exactly once: completion counter delta 1, one output child, and the
  expected `ZOOM-Q`, `ZOOM-ESCAPE`, or `ZOOM-END` output.
- At 200%, the restored prompt prefix and typed command glyphs were visible for
  all three exits. At 400%, the prefix was visible after Q but typed command
  glyphs were outside the viewport; after Escape and natural end, both prefix
  visibility and typed command glyph exposure failed. Commands nevertheless
  completed exactly once.

## Evidence and files

- `measurements.json` — raw geometry, media features, loaded style checks,
  computed positions, per-check failures, scroll results, command completion
  counts, and reset result.
- `200-percent-zoom-menu.png`, `400-percent-zoom-menu.png` — native zoom menu
  readouts.
- `pager-200-open.png`, `pager-400-open.png` — pager states at zoom.
- `baseline-100.png`, `ordinary-layout-100.png` — baseline and post-reset
  ordinary layout.
- `native-pager-journey.mjs` — bounded single-process headed-browser test and
  evidence capture. No app source was edited.
- `capture-native-browser-state.sh` — existing host/browser diagnostic helper.
