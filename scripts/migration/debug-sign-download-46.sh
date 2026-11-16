#!/usr/bin/env bash
set -euo pipefail
API=http://127.0.0.1:18787
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"
email=$(grep '^admin|' /tmp/pesowise-migration-staging/staging-test-users.emails | cut -d'|' -f2)
jar=$(mktemp)
curl -s -c "$jar" -H 'Content-Type: application/json' -d "{\"email\":\"${email}\",\"password\":\"${PW}\"}" "$API/api/auth/login" >/dev/null
path=$(docker exec pesowise-postgres-migration-v2 psql -U pesowise_migration -d pesowise -tAc "SELECT storage_path FROM public.attachments WHERE storage_path LIKE '361fbbcc%' LIMIT 1;" | tr -d '[:space:]')
enc=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''${path}''', safe=''))")
json=$(curl -s -b "$jar" "$API/api/storage/sign-download?bucket=receipts&key=${enc}")
echo "path=$path"
echo "$json" | head -c 400
echo
url=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))")
curl -s -o /dev/null -w "download_http=%{http_code}\n" "$url"
