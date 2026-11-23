#!/bin/bash
# Default: full release gate. Post-merge explicitly requests setup checks.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-release}"
if [[ "$#" -gt 1 || ( "$mode" != "release" && "$mode" != "--setup-only" ) ]]; then
  echo "Usage: validate-merged.sh [--setup-only]" >&2
  exit 2
fi
stage="Python compilation and isolated startup"
trap 'echo "Merged-code validation FAILED: ${stage} (line ${LINENO}). See preceding diagnostics." >&2' ERR

echo "[merged-code] ${stage}"
timeout 45s python scripts/validate-python.py --setup-only

stage="frontend typecheck"
echo "[merged-code] ${stage}"
# The imported frontend calls this type-check, not the workspace's typecheck.
timeout 60s pnpm --filter @workspace/fun-with-flags run type-check

stage="braces nesting security regression"
echo "[merged-code] ${stage}"
node scripts/test-braces-nesting.mjs

if [[ "$mode" == "--setup-only" ]]; then
  echo "[merged-code] SETUP PASS: Python startup and frontend typecheck. Browser release validation not run. Curl release validation not run."
  exit 0
fi

stage="offline curl safety regressions"
echo "[merged-code] ${stage}"
# The Python supervisor gives the suite 180s and kills its entire process group,
# including stalled workers. This outer deadline also bounds supervisor teardown.
timeout --kill-after=10s 200s python scripts/validate-python.py --curl

stage="offline Chromium terminal checks"
echo "[merged-code] ${stage}"
# No browser downloads, preview server, live API, or persistent browser profile.
# Bound the entire runner, including bundle setup and teardown. Kill a stuck
# process group if it ignores TERM; propagate timeout and test failures.
# The expanded Matrix lifecycle suite outgrew the original eight-minute budget
# on build workers. Individual tests and navigations remain bounded.
timeout --kill-after=10s 900s pnpm --filter @workspace/fun-with-flags run test:browser
echo "[merged-code] PASS: Python compilation, isolated startup, frontend typecheck, offline curl safety regressions, offline Chromium terminal checks"