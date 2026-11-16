#!/usr/bin/env bash
# Phase 15: restore PesoWise dump into migration v2 DB only (not production Supabase).
set -euo pipefail
DUMP="${1:-/tmp/pesowise-migration-backup/pesowise-20260930T062343Z.dump}"
TARGET=pesowise-postgres-migration-v2
if [[ ! -f "$DUMP" ]]; then
  echo "Missing dump: $DUMP" >&2
  exit 1
fi
docker cp "$DUMP" "$TARGET:/tmp/pesowise.restore.dump"
docker exec "$TARGET" pg_restore -U pesowise_migration -d pesowise --no-owner --role=pesowise_migration -j 4 /tmp/pesowise.restore.dump || true
docker exec "$TARGET" rm -f /tmp/pesowise.restore.dump
docker exec "$TARGET" psql -U pesowise_migration -d pesowise -tAc "SELECT count(*) FROM public.expenses;"
echo "RESTORE_ATTEMPT_DONE"
