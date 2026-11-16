#!/usr/bin/env bash
set -euo pipefail
SRC_MINIO=supabase-minio-kar0ro1k6jiyfxzzw7acnsza
TGT_MINIO=pesowise-minio-migration-v2
OUT=/tmp/pesowise-migration-backup/storage-migration
mkdir -p "$OUT"

mapfile -t src_creds < <(docker exec "$SRC_MINIO" sh -c 'printf "%s\n%s\n" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"')
mapfile -t tgt_creds < <(docker exec "$TGT_MINIO" sh -c 'printf "%s\n%s\n" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"')
SRC_USER="${src_creds[0]}"; SRC_PASS="${src_creds[1]}"
TGT_USER="${tgt_creds[0]}"; TGT_PASS="${tgt_creds[1]}"

NET=$(docker inspect "$SRC_MINIO" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
docker network connect "$NET" "$TGT_MINIO" 2>/dev/null || true

setup_mc() {
  docker exec "$TGT_MINIO" sh -c "
    mc alias set src http://${SRC_MINIO}:9000 '${SRC_USER}' '${SRC_PASS}' >/dev/null
    mc alias set tgt http://127.0.0.1:9000 '${TGT_USER}' '${TGT_PASS}' >/dev/null
  "
}

setup_mc

for b in receipts expense-attachments organization-logos generated-reports balance-import-archive bills; do
  docker exec "$TGT_MINIO" sh -c "mc mb --ignore-existing tgt/${b} && mc mirror --overwrite src/${b} tgt/${b}"
  echo "BUCKET_MIRROR_OK:${b}" | tee -a "$OUT/mirror.log"
done

docker exec "$TGT_MINIO" sh -c "
  for b in receipts expense-attachments organization-logos generated-reports balance-import-archive bills; do
    sc=\$(mc ls -r src/\${b} 2>/dev/null | wc -l)
    tc=\$(mc ls -r tgt/\${b} 2>/dev/null | wc -l)
    dl=\$(mc diff src/\${b} tgt/\${b} 2>/dev/null | wc -l)
    echo \"bucket \${b} src_lines=\${sc} tgt_lines=\${tc} diff_lines=\${dl}\"
  done
" | tee "$OUT/diff-summary.txt"

total_diff=$(grep -o 'diff_lines=[0-9]*' "$OUT/diff-summary.txt" | awk -F= '{s+=$2} END {print s+0}')
echo "CHECKSUM_SUMMARY mc_diff_total_lines=$total_diff" | tee "$OUT/checksum-summary.txt"
echo "STORAGE_MIGRATION_DONE"
