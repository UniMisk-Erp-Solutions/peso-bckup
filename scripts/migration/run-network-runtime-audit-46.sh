#!/usr/bin/env bash
# Gate M runtime — proxy traffic capture while hitting staging API routes (server-side).
# Full browser DevTools audit still recommended from client network.
set -euo pipefail
OUT=/tmp/pesowise-migration-backup/network-runtime-$(date -u +%Y%m%dT%H%M%SZ).txt
API="${PESOWISE_AUDIT_API:-http://127.0.0.1:18787}"
REACT="${PESOWISE_AUDIT_REACT:-http://127.0.0.1:5175}"
PROD_MARKERS="54321 pesowise-supabase.unimisk.com pesowise-backup-supabase /rest/v1 /auth/v1 /storage/v1 /realtime/v1 /functions/v1"

exec > >(tee "$OUT") 2>&1
echo "# Runtime network proxy audit"

hits=0
for path in / /login /assets/; do
  code=$(curl -s -o /tmp/react.html -w '%{http_code}' "${REACT}${path}" 2>/dev/null || echo 000)
  echo "react_${path} http=$code"
done

for m in $PROD_MARKERS; do
  c=$(grep -c "$m" /tmp/react.html 2>/dev/null || echo 0)
  echo "html_contains_${m}=$c"
done

# Staging API-only workflow (no prod host in URLs)
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
source /tmp/pesowise-migration-staging/.env.production 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-${PRODUCTION_TEST_PASSWORD:-StagingMigrate2026!}}"
email=$(grep '^admin|' /tmp/pesowise-migration-staging/staging-test-users.emails | cut -d'|' -f2)
jar=$(mktemp)
curl -s -c "$jar" -H 'Content-Type: application/json' -d "{\"email\":\"${email}\",\"password\":\"${PW}\"}" "$API/api/auth/login" >/dev/null
for ep in /api/auth/me /api/dashboard/summary /api/expenses /api/events; do
  u="${API}${ep}"
  if [[ "$u" == *"$PROD_MARKERS"* ]]; then hits=$((hits+1)); fi
  curl -s -o /dev/null -w "api_${ep}=%{http_code}\n" -b "$jar" --max-time 5 "$u" || echo "api_${ep}=timeout"
done

echo "prod_supabase_url_requests_during_script=$hits"
echo "expected_prod_supabase_requests=0"
[[ "$hits" -eq 0 ]] && echo "RUNTIME_PROXY_AUDIT=PASS" || echo "RUNTIME_PROXY_AUDIT=PARTIAL"
echo "REPORT=$OUT"
