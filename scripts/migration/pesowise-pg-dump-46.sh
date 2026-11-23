#!/usr/bin/env bash
# Phase 3: PesoWise-only pg_dump (non-destructive). Run ON .46 only.
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
OUT_DIR=/tmp/pesowise-migration-backup
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT_DIR"

DUMP="$OUT_DIR/pesowise-${TS}.dump"
SCHEMA="$OUT_DIR/pesowise-${TS}.schema.sql"

echo "Starting pg_dump custom format..."
docker exec "$DB" pg_dump -U supabase_admin -d postgres -Fc -f "/tmp/pesowise.dump"
docker cp "$DB:/tmp/pesowise.dump" "$DUMP"
docker exec "$DB" rm -f /tmp/pesowise.dump

docker exec "$DB" pg_dump -U supabase_admin -d postgres --schema-only -f "/tmp/pesowise.schema.sql"
docker cp "$DB:/tmp/pesowise.schema.sql" "$SCHEMA"
docker exec "$DB" rm -f /tmp/pesowise.schema.sql

pg_restore --list "$DUMP" > "$OUT_DIR/pesowise-${TS}.restore-list.txt"
sha256sum "$DUMP" "$SCHEMA" > "$OUT_DIR/pesowise-${TS}.sha256"
ls -la "$DUMP" "$SCHEMA"
echo "BACKUP_OK dump=$DUMP"
echo "RESTORE_LIST=$OUT_DIR/pesowise-${TS}.restore-list.txt"
