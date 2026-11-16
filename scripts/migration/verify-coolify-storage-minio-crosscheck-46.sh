#!/usr/bin/env bash
set -euo pipefail
DB=mqgd6kfhdrcbpa2c2bvyjwvc
MINIO=pesowise-minio-coolify-primary
OUT=/tmp/pesowise-migration-backup/storage-minio-crosscheck-$(date -u +%Y%m%dT%H%M%SZ).txt
exec > >(tee "$OUT") 2>&1

echo "STORAGE_MINIO_CROSSCHECK db=$DB minio=$MINIO"

docker exec "$DB" psql -U pesowise_app -d pesowise -tAc \
  "SELECT count(*) FROM storage.objects" | awk '{print "storage_objects_count="$1}'
docker exec "$DB" psql -U pesowise_app -d pesowise -tAc \
  "SELECT coalesce(sum((metadata->>'size')::bigint),0) FROM storage.objects" | awk '{print "metadata_bytes="$1}'

docker exec "$DB" psql -U pesowise_app -d pesowise -tAc \
  "SELECT o.bucket_id || '|' || o.name || '|' || coalesce(o.version,'') FROM storage.objects o" \
  > /tmp/storage-objects-keys.txt
KEYS=/tmp/storage-objects-keys.txt
docker cp "$KEYS" "$MINIO:/tmp/storage-objects-keys.txt"

docker exec "$MINIO" sh -c '
  mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  missing=0
  checked=0
  while IFS="|" read -r bucket name ver; do
    [ -z "$bucket" ] || [ -z "$name" ] && continue
    checked=$((checked+1))
    ok=0
    if [ -n "$ver" ] && mc stat "local/stub/storage-single-tenant/${bucket}/${name}/${ver}" >/dev/null 2>&1; then ok=1; fi
    if [ "$ok" = 0 ] && mc stat "local/stub/storage-single-tenant/${bucket}/${name}" >/dev/null 2>&1; then ok=1; fi
    if [ "$ok" = 0 ] && mc stat "local/stub/storage-single-tenant/receipts/${name}/${ver}" >/dev/null 2>&1; then ok=1; fi
    if [ "$ok" = 0 ] && mc stat "local/stub/storage-single-tenant/receipts/${name}" >/dev/null 2>&1; then ok=1; fi
    if [ "$ok" = 0 ]; then
      missing=$((missing+1))
      [ "$missing" -le 10 ] && echo "MISSING ${bucket}|${name}|${ver}"
    fi
    if [ $((checked % 5000)) -eq 0 ]; then echo "progress checked=$checked missing=$missing"; fi
  done < /tmp/storage-objects-keys.txt
  echo "objects_checked=$checked missing_in_minio=$missing"
  [ "$missing" -eq 0 ] && echo CROSSCHECK_RESULT=PASS || echo CROSSCHECK_RESULT=FAIL
'

echo "REPORT=$OUT"
