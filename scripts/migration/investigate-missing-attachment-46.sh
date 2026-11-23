#!/usr/bin/env bash
# Classify a missing-target attachment (Gate J).
set -euo pipefail
AID="${1:-e1a68041}"
SRC_DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
TGT_DB=pesowise-postgres-migration-v2
SRC_MINIO=supabase-minio-kar0ro1k6jiyfxzzw7acnsza
TGT_MINIO=pesowise-minio-migration-v2
OUT=/tmp/pesowise-migration-backup/missing-attachment-${AID}-$(date -u +%Y%m%dT%H%M%SZ).txt
exec > >(tee "$OUT") 2>&1

row=$(docker exec "$TGT_DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT id::text||'|'||coalesce(storage_path,'')||'|'||coalesce(file_url,'') FROM public.attachments WHERE id::text LIKE '${AID}%' LIMIT 1;")
echo "target_row=$row"
path="${row#*|}"; path="${path%%|*}"
ver=$(docker exec "$TGT_DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT version FROM storage.objects WHERE name='$path' LIMIT 1;" 2>/dev/null || true)
echo "storage_version=$ver"

for pair in "source:$SRC_MINIO" "target:$TGT_MINIO"; do
  label="${pair%%:*}"
  c="${pair##*:}"
  echo "## minio_$label"
  docker exec "$c" sh -c "mc alias set local http://127.0.0.1:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null 2>&1; mc stat \"local/stub/storage-single-tenant/receipts/${path}/${ver}\" 2>&1 | head -2" || true
done

echo "REPORT=$OUT"
