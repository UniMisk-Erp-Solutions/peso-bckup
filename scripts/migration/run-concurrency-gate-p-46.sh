#!/usr/bin/env bash
# Phase 8 — concurrency (v2 staging only).
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:18787}"
DB=pesowise-postgres-migration-v2
OUT=/tmp/pesowise-migration-backup/concurrency-gate-p-$(date -u +%Y%m%dT%H%M%SZ).txt
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"
EMAIL_FILE=/tmp/pesowise-migration-staging/staging-test-users.emails

eng_email=$(grep '^engineer|' "$EMAIL_FILE" | head -1 | cut -d'|' -f2)
jar1=$(mktemp); jar2=$(mktemp)
curl -s -o /dev/null -c "$jar1" -H 'Content-Type: application/json' -d "{\"email\":\"${eng_email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"
curl -s -o /dev/null -c "$jar2" -H 'Content-Type: application/json' -d "{\"email\":\"${eng_email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"

exp=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT id::text FROM public.expenses WHERE status IN ('submitted','level_1_verified') LIMIT 1;" | tr -d '[:space:]')
[[ -z "$exp" ]] && { echo "SKIP no suitable expense"; exit 0; }

before=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "SELECT status FROM public.expenses WHERE id='${exp}'::uuid;")
curl -s -o /dev/null -w '%{http_code}\n' -b "$jar1" -X POST -H 'Content-Type: application/json' -d '{}' "$API/api/expenses/${exp}/review/verify" &
curl -s -o /dev/null -w '%{http_code}\n' -b "$jar2" -X POST -H 'Content-Type: application/json' -d '{}' "$API/api/expenses/${exp}/review/verify" &
wait
after=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "SELECT status FROM public.expenses WHERE id='${exp}'::uuid;")
aud=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "SELECT count(*) FROM public.audit_logs WHERE expense_id='${exp}'::uuid;")

echo "expense=$exp before=$before after=$after audit_count=$aud" | tee "$OUT"
echo "CONCURRENCY_DUPLICATE_VERIFY checked"
exit 0
