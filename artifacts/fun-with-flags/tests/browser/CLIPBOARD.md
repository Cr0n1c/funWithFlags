# Terminal output clipboard regression matrix

This suite covers normal shell output, not mobile vi input. It builds the real
frontend in memory, uses fresh synthetic signed-in sessions, blocks service
workers/WebSockets and unknown network requests, and never contacts the running
API, Okta, or persistent player data.

## Run

Install the browsers matching the installed Playwright version first:

```sh
pnpm --filter @workspace/fun-with-flags exec playwright install chromium firefox webkit
pnpm --filter @workspace/fun-with-flags run test:clipboard
```

On supported Linux CI hosts, Playwright's `install-deps` command supplies native
libraries. Where it cannot install system packages,
use compatible system-provided browser launchers. `CHROMIUM_PATH`,
`FIREFOX_PATH`, and `WEBKIT_PATH` can override executables; overrides must speak
the installed Playwright protocol. An arbitrary stock Firefox or an older
Playwright browser is not interchangeable with the required binary.

One engine, without running unrelated journeys:

```sh
TERMINAL_BROWSER=firefox pnpm --filter @workspace/fun-with-flags run test:browser \
  tests/browser/terminal.smoke.ts -t 'clipboard:'
```

The matrix runs sequentially to avoid shared OS clipboard interference. Missing
browsers and failed checks fail the command, rather than being silently skipped.
The ordinary browser suite keeps its Chromium default.

## Automated evidence

| Check | How it is exercised |
| --- | --- |
| Drag auto-copy | Real mouse down/move/up over output with production styles; no copy while dragging |
| Keyboard selection | Seed an output range, then real Shift+ArrowLeft; no synthetic key event or `Selection.modify` |
| Clipboard contents | Native Ctrl+V into the prompt, not a mocked write or permission-granted read |
| Plain text / caret | Native copy of markup-looking multiline text, paste inside an existing draft; no HTML, output change or command completion |
| Native denial | Chromium uses its native permission controls to deny writes; Firefox/WebKit select after transient activation expires |
| Manual fallback | After actual denial, native Ctrl+C preserves selection and Ctrl+V retrieves its bytes; retry selection remains possible |
| Touch contract | Touch-enabled narrow viewport; DOM range adjustments produce actual `selectionchange`, without fabricated pointerup |
| Ownership | No copying from the prompt; hidden shell prompt prevents output writes and document-level paste redirection |

The touch contract deliberately spies on writes to isolate event handling from
browser permissions. It is **not** evidence of actual OS selection handles.
Firefox's automation clipboard bypass preference is explicitly disabled.
Selection for denial is scheduled after a delay because browser automation
evaluation can itself confer transient activation. A page-local observer awaits
the result without repeated evaluations that could renew activation.

## Runtime verification on this workspace

- Chromium: native drag/keyboard/caret paste and native permission denial
  exercised successfully.
- Firefox 155 / Playwright 1.63: native drag/keyboard/caret paste, real
  user-activation denial and manual fallback exercised successfully.
- WebKit 26.6 / Playwright 1.63 (2026-10-08): all three clipboard journeys passed
  using the matching GTK MiniBrowser under Xvfb. This includes native drag,
  Shift+Arrow selection, literal caret paste, actual user-activation denial,
  manual Ctrl+C/Ctrl+V fallback, touch-event contracts and hidden-prompt ownership.
  This is WebKit evidence, not a claim about shipping Safari or native iOS.

### Workspace-specific WebKit runtime

The cached Nix WPE runtime could launch but failed to create an EGL display.
The matching downloaded GTK runtime works under Xvfb with software rendering
(`GSK_RENDERER=cairo`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`). Its executables need
the Nix ELF loader and matching shared-library paths, including ICU 74,
libjpeg 8, GTK 4, libmanette, enchant, hyphen, libsecret and libpsl.
GStreamer base/good plugin paths must also be exposed: a blank page can load
without them, while the terminal's audio initialization crashes the web process.

The prepared, workspace-local launcher is `.cache/webkit-clipboard`. Run from
the repository root:

```sh
TERMINAL_BROWSER=webkit WEBKIT_PATH="$PWD/.cache/webkit-clipboard" \
  pnpm --filter @workspace/fun-with-flags run test:browser \
  tests/browser/terminal.smoke.ts -t 'clipboard:'
```

That launcher and downloaded browser binaries are local test infrastructure,
not application source. Reinstalling browsers or using a fresh workspace
requires preparing a compatible runtime again; do not expect ignored `.cache`
files to survive a clean checkout. Prefer the standard Playwright installation
on a supported Linux CI host for repeatable cross-browser runs.

The local GTK launcher disables WebKit's process sandbox for this isolated
synthetic test fixture. Do not reuse it for general browsing, real customer
sessions or production data. No app authorization or production runtime
settings were changed.

## Native-device checks (not supported by Playwright)

Desktop WebKit is not shipping Safari, and mobile viewport/touch emulation does
not provide iOS or Android's native long-press selection handles or Copy menu.
On iOS Safari and Android Firefox, use an isolated synthetic/offline session:

1. Long-press ordinary output and extend/shrink both selection handles. Ensure
   the selected text stays selected and the shell draft/focus is not stolen.
2. If automatic copying is restricted, use **Copy** in the selection menu,
   then **Paste** in the shell. Check the exact selected bytes.
3. Paste multiline/HTML-looking text inside a draft. It must remain literal,
   with line breaks replaced by spaces, until a separate Enter submission.
4. Open vi and a challenge pager. Verify their selection/input stays owned by
   that view, without shell auto-copy or shell paste interception.

Do not use real flags, authenticated production sessions, or live integrations
for these checks. Native-handle checks remain unverified in this environment.
