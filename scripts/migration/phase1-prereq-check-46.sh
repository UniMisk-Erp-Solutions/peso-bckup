#!/usr/bin/env bash
# Phase 1 read-only: PesoWise migration prerequisites on .46 only.
set -euo pipefail
echo "PHASE1_PREREQ_CHECK"
fail=0
check() { if "$@"; then echo "$1=PASS"; else echo "$1=FAIL"; fail=1; fi; }

check docker ps --filter name=pesowise-postgres-migration-v2 --format '{{.Names}}' | grep -q pesowise-postgres-migration-v2
check docker ps --filter name=pesowise-minio-migration-v2 --format '{{.Names}}' | grep -q pesowise-minio-migration-v2
check docker ps --filter name=kar0ro1k6jiyfxzzw7acnsza --format '{{.Names}}' | head -1 | grep -q kar0ro1k6jiyfxzzw7acnsza
check docker ps --filter name=pesowise-frontend --format '{{.Names}}' | grep -q pesowise-frontend
check test -f /tmp/pesowise-migration-v2/.env
check test -f /tmp/pesowise-migration-v2-minio/.env
check test -f /tmp/ha/deploy-staging-api-46.sh || test -f /tmp/pesowise-migration-staging/deploy-staging-api-46.sh

echo "=== production frontend env names (values redacted) ==="
docker inspect pesowise-frontend --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | grep -E '^VITE_SUPABASE_URL=|^VITE_API_URL=' || true
if docker inspect pesowise-frontend --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^VITE_SUPABASE_URL='; then
  echo "prod_frontend_vite_supabase=PASS"
else
  echo "prod_frontend_vite_supabase=FAIL"; fail=1
fi
if docker inspect pesowise-frontend --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^VITE_API_URL='; then
  echo "prod_frontend_vite_api_unexpected=FAIL"; fail=1
else
  echo "prod_frontend_no_vite_api=PASS"
fi

if [[ "$fail" -eq 0 ]]; then echo "PHASE1_OVERALL=PASS"; else echo "PHASE1_OVERALL=FAIL"; fi
exit "$fail"
