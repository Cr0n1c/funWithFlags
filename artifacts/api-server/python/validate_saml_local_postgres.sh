#!/usr/bin/env bash
# Run only against a fresh, disposable local cluster; never the application DB.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
for tool in initdb pg_ctl psql python; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool"; exit 1; }
done
work="$(mktemp -d /tmp/saml-local-postgres.XXXXXXXX)"
started=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$started" = 1 ]; then
    if ! pg_ctl -D "$work/data" -m immediate -w stop >/dev/null 2>&1; then
      echo "Local PostgreSQL shutdown failed; temporary cluster retained."
      exit 1
    fi
  fi
  rm -rf -- "$work"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$work/socket"
# Private filesystem access replaces passwords. No network listener is enabled.
initdb -D "$work/data" -U saml_local_admin --auth-local=trust --auth-host=reject \
  --no-locale --encoding=UTF8 >"$work/init.log" 2>&1
pg_ctl -D "$work/data" -l "$work/server.log" \
  -o "-c listen_addresses='' -c unix_socket_directories='$work/socket' -c unix_socket_permissions=0700" \
  -w start >/dev/null
started=1
psql -X -w -h "$work/socket" -U saml_local_admin -d postgres \
  -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE saml_validation LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE saml_validation OWNER saml_validation;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL
ENVIRONMENT=development \
SAML_TEST_POSTGRES_APPROVAL=dedicated-nonproduction \
SAML_TEST_POSTGRES_URL="postgresql+asyncpg://saml_validation@/saml_validation?host=$work/socket" \
  python validate_saml_postgres.py
remaining="$(psql -X -w -h "$work/socket" -U saml_validation -d saml_validation \
  -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_namespace WHERE nspname ~ '^saml_test_[0-9a-f]{32}$'")"
if [ "$remaining" != 0 ]; then
  echo "Local PostgreSQL validation FAILED: test schemas remain."
  exit 1
fi
echo "Local PostgreSQL cleanup confirmed: zero test schemas remain."