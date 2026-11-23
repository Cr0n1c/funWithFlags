# Terminal pager: desktop reflow and enlarged text

## Automated evidence

Run the offline production-bundle journeys with synthetic authentication and
synthetic challenge rows (no live Okta, scoring, or database writes):

```sh
pnpm --filter @workspace/fun-with-flags run test:browser --testNamePattern='keeps pager exits'
```

The desktop-only cases use mouse/keyboard contexts, not mobile/touch emulation:

| Case | CSS viewport | Terminal text |
| --- | --- | --- |
| 200% equivalent reflow from 1280×900 | 640×450 | 20px |
| 400% equivalent reflow from 1280×900 | 320×225 | 20px |
| 200% text enlargement | 1280×900 | 40px |

The text case explicitly doubles the terminal's fixed-pixel output, input, and
prefix, as well as the root font. Root-font changes alone would not exercise
the existing 20px pager text.

Each case changes the layout with a pager already open, then reopens it at the
new size. Checks cover every status/quit instruction glyph, a reading area of at
least one complete row, Enter/Space movement, wide-table horizontal scrolling
with the far-right column exposed, Q and Escape exits, natural completion, and
immediate prompt focus, visible typed text, and exactly-once command execution.
Hit-testing detects fixed CRT controls covering otherwise visible elements.
Desktop paging temporarily hides hardware controls; exits restore them.

These are Chromium layout and keyboard regression checks, **not native browser
zoom-menu, assistive-technology, Firefox, or Safari evidence**. Phone rotation is
outside this task.

## Recorded native-browser evidence

The [2026-10-08 native Chromium report](evidence/pager-native-zoom/REPORT.md)
records actual 200%/400% browser zoom, live OS window resizing, keyboard paging,
table scrolling, all exit paths, immediate commands, and reset to 100%, with
screenshots and raw measurements.

This is **not a readability pass**: the available headed browser reported no
hover/fine pointer, leaving the hover-gated desktop layout inactive. Hardware
overlap and clipped command text were observed. The intended hover-capable
desktop branch remains unverified. Firefox, Safari, and native text-only zoom
were unavailable and are not recorded as passed.

On 2026-10-08, the user explicitly signed off on closing this verification task
with these documented limitations. That acceptance waives further verification
for closure; it does not turn failed or unverified checks into passes.

## Native desktop verification procedure

In a signed-in desktop browser, use its actual zoom menu at 200% and 400% with a
1280×900 content area at 100%, and its text-only zoom setting at 200% where
supported. Record the browser/version, actual resulting CSS viewport, text size,
and screenshots rather than treating device scale factor or pinch zoom as page
zoom.

1. Open a challenge table long enough to page and wider than the reading area.
2. Change zoom while the pager is open. Confirm all instructions, particularly
   `Q/Esc: quit`, remain readable and clear of CRT hardware.
3. Press Enter and Space; confirm row/page advancement and stable instructions.
4. Scroll the table horizontally to the final column, then back. Confirm the
   instructions do not move horizontally with the table.
5. Quit with Q, reopen and quit with Escape, then reopen and page to the end.
   After each exit, immediately type and run a command without clicking.
6. Confirm visible command text, a usable prompt, restored hardware controls,
   and no duplicated execution. Restore 100% and confirm ordinary layout.
