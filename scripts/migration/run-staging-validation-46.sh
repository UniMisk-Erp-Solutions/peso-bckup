#!/usr/bin/env bash
# Non-destructive staging smoke checks (no production frontend changes).
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:18787}"
OUT=/tmp/pesowise-migration-backup/staging-validation-$(date -u +%Y%m%dT%H%M%SZ).txt

{
  echo "STAGING_VALIDATION api=$API"
  curl -sf "$API/health" && echo " health=PASS" || echo " health=FAIL"
  curl -sf "$API/ready" && echo " ready=CHECK" || echo " ready=FAIL"
  echo "auth_login=SKIPPED (set STAGING_TEST_EMAIL + STAGING_TEST_PASSWORD to enable)"
  if [[ -n "${STAGING_TEST_EMAIL:-}" && -n "${STAGING_TEST_PASSWORD:-}" ]]; then
    jar=$(mktemp)
    code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -H 'Content-Type: application/json' \
      -d "{\"email\":\"${STAGING_TEST_EMAIL}\",\"password\":\"${STAGING_TEST_PASSWORD}\"}" \
      "$API/api/auth/login")
    echo "auth_login_http=$code"
    me=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$API/api/auth/me")
    echo "auth_me_http=$me"
    rm -f "$jar"
  fi
  echo "VALIDATION_DONE"
} | tee "$OUT"
echo "REPORT=$OUT"
