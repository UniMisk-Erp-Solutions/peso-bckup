#!/usr/bin/env bash
# Phase 2 — RBAC / IDOR gate I (staging API + v2 DB).
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:18787}"
DB=pesowise-postgres-migration-v2
EMAIL_FILE=/tmp/pesowise-migration-staging/staging-test-users.emails
OUT=/tmp/pesowise-migration-backup/rbac-gate-i-$(date -u +%Y%m%dT%H%M%SZ).md
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"

exec > >(tee "$OUT") 2>&1
pass=0; fail=0
row() {
  echo "| $1 | $2 | $3 | $4 |"
  [[ "$4" == "PASS" ]] && pass=$((pass+1)) || fail=$((fail+1))
}

login_as() {
  local role=$1 jar=$2
  local email; email=$(grep "^${role}|" "$EMAIL_FILE" | head -1 | cut -d'|' -f2)
  curl -s -o /dev/null -c "$jar" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"
}

echo "# RBAC validation (Gate I)"
echo "| case | http | expected | result |"

emp_jar=$(mktemp); admin_jar=$(mktemp)
login_as employee "$emp_jar"
login_as admin "$admin_jar"

emp_id=$(grep '^employee|' "$EMAIL_FILE" | head -1 | cut -d'|' -f3)
other_exp=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT id::text FROM public.expenses WHERE user_id <> '${emp_id}'::uuid LIMIT 1;" | tr -d '[:space:]')
own_exp=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT id::text FROM public.expenses WHERE user_id = '${emp_id}'::uuid LIMIT 1;" | tr -d '[:space:]')

if [[ -n "$own_exp" ]]; then
  c=$(curl -s -o /dev/null -w '%{http_code}' -b "$emp_jar" "$API/api/expenses/${own_exp}")
  row "employee own expense" "$c" "200" "$([[ "$c" == "200" ]] && echo PASS || echo FAIL)"
fi
if [[ -n "$other_exp" ]]; then
  c=$(curl -s -o /dev/null -w '%{http_code}' -b "$emp_jar" "$API/api/expenses/${other_exp}")
  row "employee other expense IDOR" "$c" "403" "$([[ "$c" == "403" ]] && echo PASS || echo FAIL)"
fi

c=$(curl -s -o /dev/null -w '%{http_code}' -b "$emp_jar" "$API/api/admin/users")
row "employee admin users" "$c" "403" "$([[ "$c" == "403" ]] && echo PASS || echo FAIL)"
c=$(curl -s -o /dev/null -w '%{http_code}' -b "$admin_jar" "$API/api/admin/users")
row "admin admin users" "$c" "200" "$([[ "$c" == "200" ]] && echo PASS || echo FAIL)"
c=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/expenses")
row "unauthenticated expenses" "$c" "401" "$([[ "$c" == "401" ]] && echo PASS || echo FAIL)"

echo "SUMMARY pass=$pass fail=$fail"
echo "REPORT=$OUT"
[[ "$fail" -eq 0 ]]
