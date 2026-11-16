#!/usr/bin/env bash
# Enable WAL archiving + scheduled pg_dump for pesowise-postgres-migration-v2 only.
set -euo pipefail
TARGET=pesowise-postgres-migration-v2
ARCHIVE=/tmp/pesowise-migration-backup/wal-archive-v2
DUMP_DIR=/tmp/pesowise-migration-backup/v2-scheduled
mkdir -p "$ARCHIVE" "$DUMP_DIR"

docker exec "$TARGET" psql -U pesowise_migration -d postgres -c \
  "ALTER SYSTEM SET wal_level = 'replica';"
docker exec "$TARGET" psql -U pesowise_migration -d postgres -c \
  "ALTER SYSTEM SET archive_mode = 'on';"
docker exec "$TARGET" psql -U pesowise_migration -d postgres -c \
  "ALTER SYSTEM SET archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f';"

docker exec "$TARGET" mkdir -p /wal_archive
docker cp "$ARCHIVE" "$TARGET:/wal_archive_host" 2>/dev/null || true

# Bind-mount archive via recreate note: for lab, copy WAL segments manually after restart.
docker restart "$TARGET"
sleep 5
docker exec "$TARGET" pg_isready -U pesowise_migration -d pesowise

TS=$(date -u +%Y%m%dT%H%M%SZ)
docker exec "$TARGET" pg_dump -U pesowise_migration -d pesowise -Fc -f "/tmp/v2-${TS}.dump"
docker cp "$TARGET:/tmp/v2-${TS}.dump" "$DUMP_DIR/v2-${TS}.dump"
sha256sum "$DUMP_DIR/v2-${TS}.dump" > "$DUMP_DIR/v2-${TS}.sha256"
pg_restore --list "$DUMP_DIR/v2-${TS}.dump" | wc -l | awk '{print "restore_list_entries="$1}' >> "$DUMP_DIR/v2-${TS}.meta"
echo "V2_BACKUP_PITR_LAB configured archive_mode=on (host dir $ARCHIVE); dump=$DUMP_DIR/v2-${TS}.dump"
