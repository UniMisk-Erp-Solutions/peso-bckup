#!/usr/bin/env bash
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:18787}"
SRC_DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
EMAIL_FILE=/tmp/pesowise-migration-staging/staging-test-users.emails
OUT=/tmp/pesowise-migration-backup/auth-gate-g-$(date -u +%Y%m%dT%H%M%SZ).md
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"

exec > >(tee "$OUT") 2>&1
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }

echo "# Auth Gate G"
for role in admin engineer employee cashier; do
  line=$(grep "^${role}|" "$EMAIL_FILE" | head -1)
  email="${line#*|}"; email="${email%%|*}"; uid="${line##*|}"
  src_uid=$(docker exec "$SRC_DB" psql -U supabase_admin -d postgres -tAc \
    "SELECT id::text FROM auth.users WHERE id='${uid}'::uuid;" 2>/dev/null | tr -d '[:space:]')
  [[ -n "$src_uid" && "$src_uid" == "$uid" ]] && ok "uuid_match_${role}" || bad "uuid_match_${role}"
  jar=$(mktemp)
  code=$(curl -s -o /tmp/l.json -w '%{http_code}' -c "$jar" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${email}\",\"password\":\"${PW}\"}" "$API/api/auth/login")
  [[ "$code" == "200" ]] && ok "login_${role}" || bad "login_${role}"
  me=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$API/api/auth/me")
  [[ "$me" == "200" ]] && ok "me_${role}" || bad "me_${role}"
  rm -f "$jar"
done

admin_email=$(grep '^admin|' "$EMAIL_FILE" | head -1 | cut -d'|' -f2)
jar=$(mktemp)
curl -s -o /dev/null -c "$jar" -H 'Content-Type: application/json' -d "{\"email\":\"${admin_email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"
lo=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -c "$jar" -X POST "$API/api/auth/logout")
[[ "$lo" == "200" ]] && ok logout || bad logout
me2=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/auth/me")
[[ "$me2" == "401" ]] && ok me_after_logout || bad me_after_logout
curl -s -o /dev/null -c "$jar" -H 'Content-Type: application/json' -d "{\"email\":\"${admin_email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"
[[ $(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$API/api/auth/me") == "200" ]] && ok relogin || bad relogin
rm -f "$jar"

bad=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"email":"nope@x.com","password":"x"}' "$API/api/auth/login")
[[ "$bad" == "401" ]] && ok invalid_login || bad invalid_login
unauth=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/expenses")
[[ "$unauth" == "401" ]] && ok unauth_protected || bad unauth_protected

echo "NOTE session_expiry refresh inactive_user not automated"
echo "SUMMARY pass=$pass fail=$fail"
echo "REPORT=$OUT"
[[ "$fail" -eq 0 ]]
