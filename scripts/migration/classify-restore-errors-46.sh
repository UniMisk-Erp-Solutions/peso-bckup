#!/usr/bin/env bash
# Classify pg_restore errors into an audit DB (does not touch production Supabase).
set -euo pipefail
TARGET=pesowise-postgres-migration-v2
DUMP="${1:-/tmp/pesowise-migration-backup/pesowise-20260930T062343Z.dump}"
AUDIT_DB=pesowise_restore_audit
OUT_DIR=/tmp/pesowise-migration-backup
LOG="$OUT_DIR/restore-errors-classify.log"
SUMMARY="$OUT_DIR/restore-error-classification.txt"

[[ -f "$DUMP" ]] || { echo "Missing dump: $DUMP" >&2; exit 1; }

docker exec "$TARGET" psql -U pesowise_migration -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${AUDIT_DB}' AND pid <> pg_backend_pid();" 2>/dev/null || true
docker exec "$TARGET" psql -U pesowise_migration -d postgres -c "DROP DATABASE IF EXISTS ${AUDIT_DB};"
docker exec "$TARGET" psql -U pesowise_migration -d postgres -c "CREATE DATABASE ${AUDIT_DB};"

docker cp "$DUMP" "$TARGET:/tmp/pesowise.audit.dump"
docker exec "$TARGET" bash -lc "pg_restore -U pesowise_migration -d ${AUDIT_DB} --no-owner --role=pesowise_migration -j 2 /tmp/pesowise.audit.dump" \
  >"$LOG" 2>&1 || true
docker exec "$TARGET" rm -f /tmp/pesowise.audit.dump

TOTAL=$(grep -c '^pg_restore: error:' "$LOG" || true)
WARN=$(grep -c '^pg_restore: warning:' "$LOG" || true)

{
  echo "RESTORE_ERROR_CLASSIFICATION"
  echo "dump=$DUMP"
  echo "audit_db=$AUDIT_DB"
  echo "total_pg_restore_errors=$TOTAL"
  echo "total_pg_restore_warnings=$WARN"
  echo ""
  echo "=== CATEGORY (heuristic) ==="
  echo "missing_supabase_roles=$(grep -c 'role "anon" does not exist\|role "authenticated" does not exist\|role "service_role" does not exist\|role "postgres" does not exist\|role "supabase_admin" does not exist' "$LOG" || true)"
  echo "missing_relation=$(grep -c 'relation .* does not exist' "$LOG" || true)"
  echo "permission_grant=$(grep -c '^Command was: GRANT\|^Command was: REVOKE\|must be member of role' "$LOG" || true)"
  echo "extension_or_feature=$(grep -c 'extension\|schema "vault"\|schema "graphql"' "$LOG" || true)"
  echo "already_exists=$(grep -c 'already exists' "$LOG" || true)"
  echo "other=$(( TOTAL - $(grep -Ec 'role \"(anon|authenticated|service_role|postgres|supabase_admin)\" does not exist|relation .* does not exist|already exists' "$LOG" || echo 0) ))"
  echo ""
  echo "=== TOP ERROR MESSAGES (unique) ==="
  grep '^pg_restore: error: could not execute query: ERROR:' "$LOG" \
    | sed 's/^pg_restore: error: could not execute query: ERROR:  //' \
    | sort | uniq -c | sort -rn | head -40
  echo ""
  echo "=== SAMPLE COMMANDS (first 15 unique error types) ==="
  awk '
    /^pg_restore: error:/ { err=$0; getline; if ($0 ~ /^Command was:/) print err "\n" $0 "\n" }
  ' "$LOG" | head -60
} | tee "$SUMMARY"

echo "CLASSIFY_DONE log=$LOG summary=$SUMMARY"
