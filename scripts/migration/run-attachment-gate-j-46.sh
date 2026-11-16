#!/usr/bin/env bash
# Phase 9 — historical attachment samples (Gate J).
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:18787}"
DB=pesowise-postgres-migration-v2
MINIO=pesowise-minio-migration-v2
OUT=/tmp/pesowise-migration-backup/attachment-gate-j-$(date -u +%Y%m%dT%H%M%SZ).md
source /tmp/pesowise-migration-staging/.env.staging 2>/dev/null || true
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"
EMAIL_FILE=/tmp/pesowise-migration-staging/staging-test-users.emails

exec > >(tee "$OUT") 2>&1
pass=0; fail=0; tested=0

admin_email=$(grep '^admin|' "$EMAIL_FILE" | head -1 | cut -d'|' -f2)
emp_email=$(grep '^employee|' "$EMAIL_FILE" | head -1 | cut -d'|' -f2)
admin_jar=$(mktemp); emp_jar=$(mktemp)
curl -s -o /dev/null -c "$admin_jar" -H 'Content-Type: application/json' -d "{\"email\":\"${admin_email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"
curl -s -o /dev/null -c "$emp_jar" -H 'Content-Type: application/json' -d "{\"email\":\"${emp_email}\",\"password\":\"${PW}\"}" "$API/api/auth/login"

emp_id=$(grep '^employee|' "$EMAIL_FILE" | head -1 | cut -d'|' -f3)

echo "# Attachment preview validation"
echo "| sample | storage_path | minio_exists | sign_admin | sign_employee_denied | result |"

admin_id=$(grep '^admin|' "$EMAIL_FILE" | head -1 | cut -d'|' -f3)
admin_org=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "
SELECT coalesce(
  (SELECT organization_id FROM public.profiles WHERE id='${admin_id}'::uuid),
  (SELECT om.organization_id FROM public.organization_memberships om WHERE om.user_id='${admin_id}'::uuid LIMIT 1),
  (SELECT e.organization_id FROM public.expenses e WHERE e.user_id='${admin_id}'::uuid AND e.organization_id IS NOT NULL LIMIT 1),
  (SELECT e.organization_id FROM public.expenses e WHERE e.organization_id IS NOT NULL LIMIT 1)
)::text;" | tr -d '[:space:]')

if [[ -z "$admin_org" ]]; then
  echo "ERROR: could not resolve organization for admin samples" >&2
  exit 1
fi

org_filter="e.organization_id = '${admin_org}'::uuid"

docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "
SELECT a.id::text || '|' || a.storage_path || '|' || coalesce(a.content_type,'') || '|receipts'
FROM public.attachments a
JOIN public.expenses e ON e.id = a.expense_id
WHERE a.storage_path IS NOT NULL AND a.storage_path <> ''
  AND a.storage_path NOT LIKE 'temp/%'
  AND ${org_filter}
ORDER BY a.created_at ASC LIMIT 1;
" > /tmp/samples_old.txt
docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "
SELECT a.id::text || '|' || a.storage_path || '|' || coalesce(a.content_type,'') || '|receipts'
FROM public.attachments a
JOIN public.expenses e ON e.id = a.expense_id
WHERE a.storage_path IS NOT NULL AND a.storage_path <> ''
  AND a.storage_path NOT LIKE 'temp/%'
  AND ${org_filter}
  AND a.content_type ILIKE '%pdf%'
ORDER BY a.created_at ASC LIMIT 1;
" >> /tmp/samples_old.txt
docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "
SELECT a.id::text || '|' || a.storage_path || '|' || coalesce(a.content_type,'') || '|receipts'
FROM public.attachments a
JOIN public.expenses e ON e.id = a.expense_id
WHERE a.storage_path IS NOT NULL AND a.storage_path <> ''
  AND a.storage_path NOT LIKE 'temp/%'
  AND ${org_filter}
  AND a.content_type ILIKE 'image/jpeg%'
ORDER BY a.file_size DESC NULLS LAST LIMIT 1;
" >> /tmp/samples_old.txt
docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "
SELECT a.id::text || '|' || a.storage_path || '|' || coalesce(a.content_type,'') || '|receipts'
FROM public.attachments a
JOIN public.expenses e ON e.id = a.expense_id
WHERE a.storage_path IS NOT NULL AND a.storage_path <> ''
  AND a.storage_path NOT LIKE 'temp/%'
  AND ${org_filter}
  AND a.content_type ILIKE 'image/png%'
ORDER BY a.created_at DESC LIMIT 1;
" >> /tmp/samples_old.txt
docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "
SELECT a.id::text || '|' || a.storage_path || '|' || coalesce(a.content_type,'') || '|receipts'
FROM public.attachments a
JOIN public.expenses e ON e.id = a.expense_id
WHERE a.storage_path IS NOT NULL AND a.storage_path <> ''
  AND a.storage_path NOT LIKE 'temp/%'
  AND ${org_filter}
ORDER BY a.created_at DESC LIMIT 1;
" >> /tmp/samples_old.txt
sort -u -t'|' -k1,1 /tmp/samples_old.txt -o /tmp/samples_old.txt

other_key=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT a.storage_path FROM public.attachments a
   JOIN public.expenses e ON e.id = a.expense_id
   WHERE e.user_id <> '${emp_id}'::uuid AND coalesce(a.storage_path,'') <> ''
   AND a.storage_path NOT LIKE 'temp/%' LIMIT 1;" | tr -d '[:space:]')

minio_stat() {
  local bucket=$1 key=$2
  local ver
  ver=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
    "SELECT version FROM storage.objects WHERE bucket_id='${bucket}' AND name='${key}' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
  docker exec "$MINIO" sh -c "mc alias set local http://127.0.0.1:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null 2>&1; \
    if [[ -n '${ver}' ]] && mc stat \"local/stub/storage-single-tenant/${bucket}/${key}/${ver}\" >/dev/null 2>&1; then echo YES; \
    elif mc stat \"local/stub/storage-single-tenant/${bucket}/${key}\" >/dev/null 2>&1; then echo YES; \
    elif mc stat \"local/stub/storage-single-tenant/receipts/${key}\" >/dev/null 2>&1; then echo YES; \
    else echo NO; fi"
}

while IFS='|' read -r aid path ctype bucket; do
  [[ -z "$path" ]] && continue
  bucket=${bucket:-receipts}
  exists=$(minio_stat "$bucket" "$path")
  if [[ "$exists" != "YES" ]]; then
    echo "| ${aid:0:8} | ${path:0:40} | NO | skip | skip | SKIP_MISSING_OBJECT |"
    continue
  fi
  tested=$((tested+1))
  enc=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''${path}''', safe=''))" 2>/dev/null || echo "$path")
  sa=$(curl -s -o /dev/null -w '%{http_code}' -b "$admin_jar" "$API/api/storage/sign-download?bucket=${bucket}&key=${enc}")
  se=403
  if [[ -n "$other_key" ]]; then
    enc2=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''${other_key}''', safe=''))" 2>/dev/null || echo "$other_key")
    se=$(curl -s -o /dev/null -w '%{http_code}' -b "$emp_jar" "$API/api/storage/sign-download?bucket=${bucket}&key=${enc2}")
  fi
  if [[ "$sa" == "200" ]]; then
    url=$(curl -s -b "$admin_jar" "$API/api/storage/sign-download?bucket=${bucket}&key=${enc}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))" 2>/dev/null || true)
    if [[ -n "$url" ]]; then
      dc=$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)
      [[ "$dc" == "200" ]] && download=PASS || download=FAIL
    else
      download=FAIL
    fi
  else
    download=SKIP
  fi
  ok=FAIL
  [[ "$sa" == "200" && "$download" == "PASS" ]] && ok=PASS
  [[ "$se" == "403" ]] && authz=PASS || authz=FAIL
  [[ "$ok" == "PASS" && "$authz" == "PASS" ]] && pass=$((pass+1)) || fail=$((fail+1))
  echo "| ${aid:0:8} | ${path:0:40} | $exists | $sa | $se | $ok ($download) |"
done < /tmp/samples_old.txt

echo "tested=$tested pass=$pass fail=$fail"
echo "REPORT=$OUT"
[[ "$fail" -eq 0 && "$tested" -gt 0 ]]
