#!/usr/bin/env bash
# Phase 15 — confirm production unchanged (read-only).
set -euo pipefail
echo "PRODUCTION_UNCHANGED_CHECK"
docker ps --filter name=kar0ro1k6jiyfxzzw7acnsza --format '{{.Names}} {{.Status}}' | head -3
docker inspect pesowise-frontend --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | grep -E '^VITE_SUPABASE_URL=|^VITE_API_URL=' | sed 's/=.*/=***redacted***/' || true
if docker inspect pesowise-frontend --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^VITE_SUPABASE_URL='; then
  echo "prod_vite_supabase=PASS"
else echo "prod_vite_supabase=FAIL"; exit 1; fi
if docker inspect pesowise-frontend --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^VITE_API_URL='; then
  echo "prod_vite_api_absent=FAIL"; exit 1
else echo "prod_vite_api_absent=PASS"; fi
echo "PRODUCTION_CHECK_PASS"
