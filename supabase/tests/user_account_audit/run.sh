#!/usr/bin/env bash
# DOC-158: runs the user-account-audit acceptance test on a DISPOSABLE Postgres container (same image family as Production).
# No volumes, no published ports, removed on exit. Never point this at a real database.
#   usage: run.sh [dir-with-the-three-sql-files]   (default: this script's own tree)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE}"
MIG="${MIGRATION_FILE:-$SRC/../../migrations/20261031100000_user_account_audit_history_v1.sql}"
IMG="${PG_IMAGE:-supabase/postgres:15.8.1.085}"
NAME="uaa-test-$$"
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=throwaway "$IMG" >/dev/null || exit 2
trap 'docker stop "$NAME" >/dev/null 2>&1' EXIT
for i in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -q 2>/dev/null && break; sleep 1; done
sleep 3
P() { docker exec -i -e PGPASSWORD=throwaway "$NAME" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
P < "$SRC/00_harness.sql" || { echo "HARNESS FAILED"; exit 3; }
P < "$MIG" || { echo "MIGRATION FAILED"; exit 4; }
P < "${MIGRATION_FILE2:-$SRC/../../migrations/20261031130000_user_account_audit_denial_snapshot_fix.sql}" || { echo "FORWARD-FIX MIGRATION FAILED"; exit 5; }
P < "$SRC/10_audit_test.sql" 2>&1 | grep -E "^(PASS|FAIL|NOTICE|RESULT|FAILED|ERROR)|PASS |FAIL |RESULT|FAILED|ERROR" | sed -E 's/^psql:[^ ]+ //'
