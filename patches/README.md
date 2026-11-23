# Braces nesting security

The latest upstream `braces` release, 3.0.3, is affected by
GHSA-vfj7-8cjw-p6xm and has no fixed release. The tracked pnpm patch
bounds parser nesting and recursion in `compile`, `expand`, and `stringify`.
The walker guards also protect callers supplying an AST directly, without parsing
a string first. Excessive nesting raises a controlled `RangeError` rather than
exhausting the Node.js stack. Ordinary patterns and 99 nested groups remain
supported; the security limit cannot be disabled through options.

Run `node scripts/test-braces-nesting.mjs` against installed dependencies.
The release gate and post-merge setup already run this check. Keep the patch
until an upstream release fixes the advisory and passes both the string and
caller-built AST regressions. Version-only scanners may still report 3.0.3;
this is a local mitigation, not an upstream version upgrade.

# Lifo compatibility

`@lifo-sh/core` is pinned to 0.10.18. Its alias expansion concatenates already
expanded arguments as unquoted source, so even a quoted filename can be split,
expanded again, or executed as shell syntax. The tracked pnpm patch quotes each
expanded argument and passes the caller's streams through alias expansion.
It transfers original assignment AST nodes to the first expanded simple command.
The parser records whether each redirect preceded the command word: prefix
redirects go before the first expanded command's redirects, while trailing ones
go after the last command's redirects. Chained aliases retain this metadata.
Both pipeline stdin and supplied stdin survive expansion. An expansion stack
prevents self aliases and cycles from recursing indefinitely.

Assignment setup and redirection opening are inside the existing environment
restoration `finally`, so failed redirects cannot leak temporary variables.
Repeated assignments save the original environment value only once.
`pnpm install --frozen-lockfile` applies it, including in browser builds.

The HP-UX builtin adapter separately validates the shared builtin-map layout,
then removes only `test`, `[` and `cd` so Lifo's normal public registry dispatch
reaches the permission-aware commands. No public builtin registration API exists
in the examined 0.10.17/0.10.18 API. Do not unpin or remove this adapter without
running the indirect-dispatch regressions and the offline terminal calibration.

This is not a general shell implementation repair. Prefix assignments or trailing
redirects whose expanded endpoint is a compound command are explicitly rejected
rather than silently discarded. Compound-command and function output capture
remain separate concerns.

Offline regressions: `pnpm --filter @workspace/fun-with-flags exec vitest run
tests/alias.test.ts tests/hpux.test.ts tests/builtinAdapter.test.ts`.
The browser smoke named “preserves alias redirections, temporary variables and
pipeline streams offline” uses the existing synthetic, network-blocked terminal
fixture; it never visits the preview, identity provider, or live API.
# Lifo shell compatibility

Lifo 0.10.18 (the latest release when investigated) still drops per-execution
stream defaults when executing compound lists and functions. Its public
`commands.run` / streaming options cannot recover those discarded streams.
It also joins function positional arguments before expanding `"$@"`.

The single patch at
`artifacts/fun-with-flags/patches/@lifo-sh__core@0.10.18.patch` keeps existing
streams attached to nested execution, preserves
exact quoted `"$@"` argument boundaries, and repeats the `printf` format for
remaining arguments. Both distributed module formats are patched. This avoids
runtime mutation of private interpreter state in the application.

Workspace pnpm installs apply the patch through `patchedDependencies`. Standalone
npm installs (including the artifact Docker build) apply that same file from the
artifact's fail-closed `postinstall` hook. The hook accepts only the locked
0.10.18 upstream files or the fully patched files, making pnpm's prepatched path
idempotent while refusing unknown dependency contents. The production build
checks that the patch is present before compiling.

When upgrading Lifo, check whether upstream fixes these behaviors before removing
or rebasing the patch. Update the locked version, patch hunks, and installer
together; do not silently drop the patch during an upgrade.

Regression checks:

```sh
# Clean temporary installs + shell regressions + production builds for both
# retained install routes (requires package registry access; no app services):
bash scripts/validate-shell-installs.sh

pnpm --filter @workspace/fun-with-flags exec vitest run tests/hpux.test.ts
pnpm --filter @workspace/fun-with-flags exec vitest run --config vitest.browser.config.ts tests/browser/shell-compounds.smoke.ts
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/fun-with-flags build

# From a standalone copy of artifacts/fun-with-flags (or its Docker context):
npm ci --ignore-scripts=false
PORT=5173 BASE_PATH=/ npm run build
```

The browser fixture bundles the real shell without application authentication,
uses an in-memory synthetic identity, and blocks and reports network requests.
