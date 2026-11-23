#!/usr/bin/env bash
# Phase 11 — staging SSE smoke test.
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:18787}"
OUT=/tmp/pesowise-migration-backup/sse-staging-$(date -u +%Y%m%dT%H%M%SZ).txt
EMAIL_FILE=/tmp/pesowise-migration-staging/staging-test-users.emails
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"

exec > >(tee "$OUT") 2>&1
pass=0; fail=0
check() { [[ "$2" == "$3" ]] && { echo "PASS $1"; pass=$((pass+1)); } || { echo "FAIL $1 got=$2 want=$3"; fail=$((fail+1)); }; }

unauth=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/events")
check unauth_401 "$unauth" 401

email=$(grep '^employee|' "$EMAIL_FILE" | head -1 | cut -d'|' -f2)
jar=$(mktemp)
curl -s -o /dev/null -c "$jar" -H 'Content-Type: application/json' -d "{\"email\":\"${email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"
body=$(timeout 3 curl -s -N -b "$jar" "$API/api/events" 2>/dev/null | head -c 200 || true)
if [[ -n "$body" ]]; then echo "PASS authenticated_stream_bytes"; pass=$((pass+1)); else echo "FAIL authenticated_stream_bytes"; fail=$((fail+1)); fi

echo "SUMMARY pass=$pass fail=$fail"
echo "REPORT=$OUT"
[[ "$fail" -eq 0 ]]
