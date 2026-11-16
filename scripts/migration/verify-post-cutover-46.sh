#!/usr/bin/env bash
set -euo pipefail
echo "POST_CUTOVER_CHECK"
docker ps --filter name=kar0ro1k6jiyfxzzw7acnsza --format '{{.Names}} {{.Status}}' | head -3
docker ps --filter name=pesowise-api --format '{{.Names}} {{.Status}}'
docker ps --filter name=pesowise-frontend --format '{{.Names}} {{.Status}}'

if docker inspect pesowise-frontend --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^VITE_SUPABASE_URL='; then
  echo "prod_still_has_build_time_supabase_env=WARN"
else
  echo "prod_supabase_env_in_container=absent_ok"
fi

HTML=$(curl -sf http://127.0.0.1:4173/ || true)
if echo "$HTML" | grep -q '54321\|/rest/v1\|/auth/v1'; then
  echo "prod_html_supabase_refs=FAIL"
  exit 1
fi
echo "prod_html_supabase_refs=PASS"

curl -sf http://127.0.0.1:8787/ready | grep -q '"ok":true' && echo "prod_api_ready=PASS" || { echo "prod_api_ready=FAIL"; exit 1; }
echo "POST_CUTOVER_PASS"
