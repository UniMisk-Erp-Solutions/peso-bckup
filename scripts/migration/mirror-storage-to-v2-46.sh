#!/usr/bin/env bash
# Copy PesoWise storage buckets from Supabase MinIO to migration MinIO + checksum manifest.
set -euo pipefail
SRC_MINIO=supabase-minio-kar0ro1k6jiyfxzzw7acnsza
TGT_MINIO=pesowise-minio-migration-v2
OUT=/tmp/pesowise-migration-backup/storage-migration
mkdir -p "$OUT"

# Read source credentials from PesoWise Supabase MinIO container env (not printed).
eval "$(docker exec "$SRC_MINIO" sh -c 'echo SRC_USER=$MINIO_ROOT_USER; echo SRC_PASS=$MINIO_ROOT_PASSWORD')"
eval "$(docker exec "$TGT_MINIO" sh -c 'echo TGT_USER=$MINIO_ROOT_USER; echo TGT_PASS=$MINIO_ROOT_PASSWORD')"

docker run --rm --network pesowise_migration_internal \
  -v "$OUT:/out" \
  minio/mc:RELEASE.2025-10-15T17-29-55Z \
  sh -c "
    set -e
    mc alias set src http://${SRC_MINIO}:9000 '${SRC_USER}' '${SRC_PASS}'
    mc alias set tgt http://${TGT_MINIO}:9000 '${TGT_USER}' '${TGT_PASS}'
    for b in receipts expense-attachments organization-logos generated-reports balance-import-archive bills; do
      mc mb --ignore-existing tgt/\${b} || true
      mc mirror --overwrite src/\${b} tgt/\${b}
    done
    mc ls -r --json tgt > /out/target-objects.jsonl || true
  "

# Build checksum manifest from source via mc stat (PesoWise buckets only)
docker run --rm --network container:${SRC_MINIO} \
  -v "$OUT:/out" \
  minio/mc:RELEASE.2025-10-15T17-29-55Z \
  sh -c "
    set -e
    mc alias set src http://127.0.0.1:9000 '${SRC_USER}' '${SRC_PASS}'
    : > /out/source-checksums.sha256
    for b in receipts expense-attachments organization-logos generated-reports balance-import-archive bills; do
      mc find src/\${b} --exec 'mc cat {}' 2>/dev/null | sha256sum | awk -v b=\${b} '{print \$1\"  \"b}' >> /out/source-checksums.sha256 || true
    done
  "

echo "STORAGE_MIRROR_DONE out=$OUT"
