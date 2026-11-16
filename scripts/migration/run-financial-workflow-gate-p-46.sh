#!/usr/bin/env bash
# Gate P — financial workflow smoke (staging v2 only).
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:18787}"
DB=pesowise-postgres-migration-v2
OUT=/tmp/pesowise-migration-backup/financial-workflow-$(date -u +%Y%m%dT%H%M%SZ).txt
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"
EMAIL_FILE=/tmp/pesowise-migration-staging/staging-test-users.emails

exec > >(tee "$OUT") 2>&1
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }

login() {
  local role=$1 jar=$2
  local email; email=$(grep "^${role}|" "$EMAIL_FILE" | head -1 | cut -d'|' -f2)
  curl -s -o /dev/null -c "$jar" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"
}

emp_jar=$(mktemp); eng_jar=$(mktemp); admin_jar=$(mktemp)
login employee "$emp_jar"
login engineer "$eng_jar"
login admin "$admin_jar"

emp_id=$(grep '^employee|' "$EMAIL_FILE" | head -1 | cut -d'|' -f3)
org=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT organization_id FROM public.expenses WHERE user_id='${emp_id}'::uuid LIMIT 1;" | tr -d '[:space:]')

bal_before=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT coalesce(balance,0) FROM public.profiles WHERE id='${emp_id}'::uuid OR user_id='${emp_id}'::uuid LIMIT 1;")

exp=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT id::text FROM public.expenses WHERE user_id='${emp_id}'::uuid AND status IN ('draft','returned') LIMIT 1;" | tr -d '[:space:]')

if [[ -z "$exp" ]]; then
  echo "SKIP no draft expense for employee workflow"
else
  st=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "SELECT status FROM public.expenses WHERE id='${exp}'::uuid;")
  sub=$(curl -s -o /dev/null -w '%{http_code}' -b "$emp_jar" -X POST "$API/api/expenses/${exp}/submit")
  st2=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "SELECT status FROM public.expenses WHERE id='${exp}'::uuid;")
  [[ "$sub" == "200" || "$sub" == "204" ]] && ok submit_http || bad submit_http
  [[ "$st" != "$st2" ]] && ok submit_status_changed || bad submit_status_changed
fi

echo "balance_before=$bal_before org=$org"
echo "SUMMARY pass=$pass fail=$fail"
echo "REPORT=$OUT"
[[ "$fail" -eq 0 ]]
