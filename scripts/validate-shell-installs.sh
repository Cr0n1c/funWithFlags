#!/usr/bin/env bash
# Exercise both retained production install paths without Docker, credentials,
# the preview server, or changes to the working dependency tree.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
app=artifacts/fun-with-flags
mkdir -p "$scratch/workspace/$app" "$scratch/standalone"

# Copy only build/test inputs, never .env files or browser/account storage.
inputs=(package.json package-lock.json .npmrc index.html tsconfig.json
        vite.config.ts vitest.config.ts vitest.browser.config.ts
        src public tests scripts patches)
for destination in "$scratch/workspace/$app" "$scratch/standalone"; do
  for input in "${inputs[@]}"; do cp -R "$root/$app/$input" "$destination/"; done
done
cp "$root/package.json" "$root/pnpm-lock.yaml" "$root/pnpm-workspace.yaml" \
   "$root/.npmrc" "$scratch/workspace/"

(
  cd "$scratch/workspace"
  pnpm --filter @workspace/fun-with-flags install --frozen-lockfile
  cd "$app"
  node scripts/apply-lifo-patch.mjs --check
  pnpm exec vitest run tests/hpux.test.ts
  PORT=5173 BASE_PATH=/ pnpm run build
  test -s dist/public/index.html
)
(
  cd "$scratch/standalone"
  npm ci --ignore-scripts=false
  node scripts/apply-lifo-patch.mjs --check
  npm exec -- vitest run tests/hpux.test.ts
  PORT=5173 BASE_PATH=/ npm run build
  test -s dist/public/index.html
)