#!/usr/bin/env bash
# COPY (never delete) PesoWise files: Supabase MinIO → pesowise-minio-coolify-primary.
set -euo pipefail
SRC=supabase-minio-kar0ro1k6jiyfxzzw7acnsza
TGT=pesowise-minio-coolify-primary
LOG=/tmp/pesowise-migration-backup/minio-copy-$(date -u +%Y%m%dT%H%M%SZ).log
exec > >(tee "$LOG") 2>&1

echo "MINIO_COPY_START mode=copy_only source=$SRC target=$TGT"

mapfile -t src_creds < <(docker exec "$SRC" sh -c 'printf "%s\n%s\n" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"')
mapfile -t tgt_creds < <(docker exec "$TGT" sh -c 'printf "%s\n%s\n" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"')
NET=$(docker inspect "$SRC" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
docker network connect "$NET" "$TGT" 2>/dev/null || true

docker exec "$TGT" sh -c "
  set -e
  mc alias set supabase http://${SRC}:9000 '${src_creds[0]}' '${src_creds[1]}'
  mc alias set coolify http://127.0.0.1:9000 '${tgt_creds[0]}' '${tgt_creds[1]}'
  mc mb --ignore-existing coolify/stub
  echo '=== Source layout (Supabase) ==='
  mc ls supabase || true
  mc du supabase/stub --depth 2 || true
  echo '=== COPY stub (all images/PDFs live here) ==='
  mc mirror --overwrite --preserve supabase/stub coolify/stub
  echo '=== Optional named buckets (copy if any objects) ==='
  for b in receipts expense-attachments organization-logos generated-reports balance-import-archive bills; do
    mc mb --ignore-existing coolify/\${b}
    mc mirror --overwrite --preserve supabase/\${b} coolify/\${b} 2>/dev/null || true
  done
  echo '=== Verify (diff must be 0) ==='
  sc=\$(mc ls -r supabase/stub 2>/dev/null | wc -l)
  tc=\$(mc ls -r coolify/stub 2>/dev/null | wc -l)
  dl=\$(mc diff supabase/stub coolify/stub 2>/dev/null | wc -l)
  echo \"stub_objects source=\${sc} target=\${tc} diff_lines=\${dl}\"
  echo '=== Sample paths in target ==='
  mc ls coolify/stub/storage-single-tenant 2>/dev/null | head -8 || mc ls coolify/stub | head -8
"

echo "CONSOLE_HINT bucket=stub folder=storage-single-tenant then org/receipts paths"
echo "MINIO_CONSOLE=http://192.168.23.46:19016"
echo "LOG=$LOG"
echo "MINIO_COPY_DONE"
