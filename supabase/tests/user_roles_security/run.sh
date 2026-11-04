#!/usr/bin/env bash
# Privilege-escalation regression suite for 20261031120000_user_roles_privilege_escalation_fix.sql.
# Runs on a DISPOSABLE Postgres container (same image family as Production; no volume, no published port). Never point at a real database.
#   usage: run.sh [dir-with-sql-files]    MIGRATION_FILE=<path> overrides the migration under test
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="${1:-$HERE}"
MIG="${MIGRATION_FILE:-$SRC/../../migrations/20261031120000_user_roles_privilege_escalation_fix.sql}"
IMG="${PG_IMAGE:-supabase/postgres:15.8.1.085}"; NAME="urs-test-$$"
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=throwaway "$IMG" >/dev/null || exit 2
trap 'docker stop "$NAME" >/dev/null 2>&1' EXIT
for i in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -q 2>/dev/null && break; sleep 1; done; sleep 3
P() { docker exec -i -e PGPASSWORD=throwaway "$NAME" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -At "$@"; }
P < "$SRC/00_baseline.sql" >/dev/null 2>&1 || { echo "BASELINE FAILED"; P < "$SRC/00_baseline.sql" 2>&1 | tail -5; exit 3; }
P < "$SRC/10_pre_fix.sql" 2>&1 | grep -E "PASS|FAIL|ERROR"
P < "$MIG" >/dev/null 2>&1 || { echo "MIGRATION FAILED"; P < "$MIG" 2>&1 | tail -5; exit 4; }
# idempotence: the migration must be re-runnable
P < "$MIG" >/dev/null 2>&1 || { echo "MIGRATION NOT IDEMPOTENT"; exit 5; }
P < "$SRC/20_post_fix.sql" 2>&1 | grep -E "PASS|FAIL|RESULT|FAILED|ERROR"
