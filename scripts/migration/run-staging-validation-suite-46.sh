#!/usr/bin/env bash
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:18787}"
OUT=/tmp/pesowise-migration-backup/staging-validation-$(date -u +%Y%m%dT%H%M%SZ).txt
EMAIL_FILE=/tmp/pesowise-migration-staging/staging-test-users.emails
# shellcheck disable=SC1091
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"

exec > >(tee "$OUT") 2>&1
echo "STAGING_VALIDATION api=$API"
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }

curl -sf "$API/health" | grep -q '"environment":"staging"' && ok health_staging || bad health_staging
curl -sf "$API/ready" | grep -q '"database":"connected"' && ok ready_db || bad ready_db
curl -sf "$API/ready" | grep -q '"storage":"connected"' && ok ready_storage || bad ready_storage

if [[ -z "$PW" || ! -f "$EMAIL_FILE" ]]; then
  bad auth_skipped_missing_credentials
else
  for role in admin engineer employee cashier; do
    line=$(grep "^${role}|" "$EMAIL_FILE" | head -1 || true)
    [[ -z "$line" ]] && { bad "login_${role}_no_user"; continue; }
    email="${line#*|}"; email="${email%%|*}"
    jar=$(mktemp)
    code=$(curl -s -o /tmp/login.json -w '%{http_code}' -c "$jar" -H 'Content-Type: application/json' \
      -d "{\"email\":\"${email}\",\"password\":\"${PW}\"}" "$API/api/auth/login")
    [[ "$code" == "200" ]] && ok "login_${role}" || bad "login_${role}_http_${code}"
    me=$(curl -s -o /tmp/me.json -w '%{http_code}' -b "$jar" "$API/api/auth/me")
    [[ "$me" == "200" ]] && ok "me_${role}" || bad "me_${role}"
    rm -f "$jar"
  done
  bad_pw=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    -d '{"email":"nobody@example.com","password":"wrong"}' "$API/api/auth/login")
  [[ "$bad_pw" == "401" ]] && ok login_invalid || bad login_invalid
fi

code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/expenses")
[[ "$code" == "401" ]] && ok rbac_unauth_expenses || bad rbac_unauth_expenses
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/events")
[[ "$code" == "401" ]] && ok sse_unauth || bad sse_unauth

echo "SUMMARY pass=$pass fail=$fail"
echo "REPORT=$OUT"
exit $(( fail > 0 ? 1 : 0 ))
