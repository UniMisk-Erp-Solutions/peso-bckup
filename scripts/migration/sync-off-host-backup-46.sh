#!/usr/bin/env bash
# Copy PesoWise migration v2 backups to authorized on-site archive (not /tmp-only).
# Does not touch production Supabase or unrelated projects.
set -euo pipefail
DEST="${PESOWISE_MIGRATION_OFFHOST_DIR:-/home/hasto/Desktop/Hasto/pesowise-backup/migration-v2}"
SRC=/tmp/pesowise-migration-backup
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DEST"/{db,wal,minio-manifest}

if [[ -f /tmp/pesowise-migration-v2-minio/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /tmp/pesowise-migration-v2-minio/.env
  set +a
fi

echo "offhost_dest=$DEST"

if [[ -d "$SRC/v2-scheduled" ]]; then
  rsync -a --delete-after "$SRC/v2-scheduled/" "$DEST/db/" 2>/dev/null || cp -a "$SRC/v2-scheduled/." "$DEST/db/"
fi
if [[ -d "$SRC/wal-archive-v2" ]]; then
  rsync -a "$SRC/wal-archive-v2/" "$DEST/wal/" 2>/dev/null || cp -a "$SRC/wal-archive-v2/." "$DEST/wal/"
fi

docker exec pesowise-minio-migration-v2 mc alias set local http://127.0.0.1:9000 \
  "${MINIO_ROOT_USER:-pesowise_migration}" "${MINIO_ROOT_PASSWORD:?}" 2>/dev/null || true
docker exec pesowise-minio-migration-v2 mc ls --recursive local/stub 2>/dev/null | wc -l \
  > "$DEST/minio-manifest/object_lines_${STAMP}.txt" || echo 0 > "$DEST/minio-manifest/object_lines_${STAMP}.txt"

sha256sum "$DEST"/db/*.dump 2>/dev/null > "$DEST/db/SHA256SUMS" || true
du -sh "$DEST"
echo "OFFHOST_SYNC=OK stamp=$STAMP"
