#!/usr/bin/env bash
# WAL point-in-time drill — migration PostgreSQL only (never production Supabase).
set -euo pipefail
SRC=pesowise-postgres-migration-v2
TEST=pesowise-postgres-pitr-wal-test
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ROOT="${PITR_BASE_DIR:-/home/hasto/Desktop/Hasto/pesowise-backup/migration-v2}"
BASE="$ROOT/pitr-bases/pitr-wal-base-${STAMP}"
WAL="$ROOT/pitr-wal-drill-${STAMP}"
OUT="$ROOT/pitr-wal-${STAMP}.txt"
source /tmp/pesowise-migration-v2/.env

exec >>"$OUT" 2>&1
mkdir -p "$BASE" "$WAL"
chmod 777 "$WAL" "$BASE" 2>/dev/null || true

echo "PITR_SRC=$SRC PITR_TEST=$TEST base=$BASE wal=$WAL"

docker exec "$SRC" sh -c 'rm -rf /tmp/wal_drill && mkdir -p /tmp/wal_drill && chmod 777 /tmp/wal_drill'
docker exec "$SRC" psql -U pesowise_migration -d postgres -c \
  "ALTER SYSTEM SET archive_command = 'test ! -f /tmp/wal_drill/%f && cp %p /tmp/wal_drill/%f';"
docker exec "$SRC" psql -U pesowise_migration -d postgres -c "SELECT pg_reload_conf();" >/dev/null

docker exec "$SRC" rm -rf /tmp/pitrbase 2>/dev/null || true
docker exec "$SRC" pg_basebackup -U pesowise_migration -D /tmp/pitrbase -Fp -Xs -P -R
docker cp "$SRC:/tmp/pitrbase/." "$BASE/"

docker exec "$SRC" psql -U pesowise_migration -d pesowise -c "
CREATE TABLE IF NOT EXISTS public.pitr_drill_markers (id serial PRIMARY KEY, phase text NOT NULL, created_at timestamptz DEFAULT now());
TRUNCATE public.pitr_drill_markers;
INSERT INTO public.pitr_drill_markers (phase) VALUES ('marker_a');
"
TARGET_LSN=$(docker exec "$SRC" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT pg_create_restore_point('pitr_drill_before_b');")
echo "recovery_target_lsn=$TARGET_LSN"
docker exec "$SRC" psql -U pesowise_migration -d pesowise -c "SELECT pg_switch_wal();"
sleep 3
docker exec "$SRC" psql -U pesowise_migration -d pesowise -c \
  "INSERT INTO public.pitr_drill_markers (phase) VALUES ('marker_b'); SELECT pg_switch_wal();"
sleep 3
echo "$TARGET_LSN" > "$WAL/recovery_target_lsn.txt"

docker cp "$SRC:/tmp/wal_drill/." "$WAL/"
docker exec "$SRC" sh -c 'for f in "$PGDATA"/pg_wal/*.history; do test -f "$f" && cp "$f" /tmp/wal_drill/; done'
docker cp "$SRC:/tmp/wal_drill/." "$WAL/" 2>/dev/null || true
chmod -R a+rX "$WAL" 2>/dev/null || true

FINISH=/tmp/pitr-finish-recovery-46.sh
if [[ ! -f "$FINISH" ]]; then
  FINISH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pitr-finish-recovery-46.sh"
fi
if [[ -f "$FINISH" ]]; then
  bash "$FINISH" "$BASE" "$WAL"
  RC=$?
  docker exec "$SRC" psql -U pesowise_migration -d postgres -c \
    "ALTER SYSTEM SET archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f';"
  docker exec "$SRC" psql -U pesowise_migration -d postgres -c "SELECT pg_reload_conf();" >/dev/null || true
  exit $RC
fi

echo "PITR_WAL=FAIL missing pitr-finish-recovery-46.sh" >&2
exit 1
