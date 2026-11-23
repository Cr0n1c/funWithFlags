#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Installing locked workspace dependencies..."
CI=true pnpm install --frozen-lockfile

# pnpm can retain stale source in an existing patched package directory even
# when its path includes the new patch hash. Verify behavior, repair once, and
# fail closed if the locked reinstall still does not apply the security patch.
if ! node scripts/test-braces-nesting.mjs; then
  echo "Braces security check failed; refreshing locked dependencies once..."
  CI=true pnpm install --force --frozen-lockfile
  node scripts/test-braces-nesting.mjs
fi

# This product uses Alembic, not the unused Drizzle scaffold. Only migrate the
# explicitly configured development environment; deployment requires separate
# schema review and must never migrate production as a post-merge side effect.
if [[ "${ENVIRONMENT:-}" == "development" && "${NODE_ENV:-development}" != "production" ]]; then
  echo "Applying reviewed Alembic migrations in development..."
  (cd artifacts/api-server/python && python -m app.cli migrate)
else
  echo "Skipping development migration outside the explicitly configured development environment."
fi

# Reconcile the environment promptly; the full browser release gate remains
# mandatory for deployment and the dedicated merged-code validation workflow.
bash scripts/validate-merged.sh --setup-only
