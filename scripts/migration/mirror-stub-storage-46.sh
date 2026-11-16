#!/usr/bin/env bash
# Mirror PesoWise Supabase MinIO stub bucket to migration MinIO (same key layout).
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

docker exec "$TGT_MINIO" sh -c "
  mc alias set src http://${SRC_MINIO}:9000 '${SRC_USER}' '${SRC_PASS}'
  mc alias set tgt http://127.0.0.1:9000 '${TGT_USER}' '${TGT_PASS}'
  mc mb --ignore-existing tgt/stub
  mc mirror --overwrite --retry src/stub tgt/stub
  echo SRC_DU:\$(mc du src/stub | tail -1)
  echo TGT_DU:\$(mc du tgt/stub | tail -1)
  echo DIFF_LINES:\$(mc diff src/stub tgt/stub | wc -l)
" | tee "$OUT/mirror-stub.log"

echo "STORAGE_STUB_MIGRATION_DONE"
