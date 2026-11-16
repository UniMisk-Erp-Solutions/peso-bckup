#!/usr/bin/env bash
# Create timestamped PostgreSQL base backup for PITR (pg_basebackup -Fp -Xs -P -R).
# DEFAULT: dry-run. Requires explicit --execute and non-production paths.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXECUTE=0
SOURCE_HOST="${PGHOST:-127.0.0.1}"
SOURCE_PORT="${PGPORT:-5432}"
SOURCE_USER="${PGUSER:-supabase_admin}"
DEST=""

usage() {
  echo "Usage: $0 --destination DIR [--host H] [--port P] [--execute]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --destination) DEST="$2"; shift 2 ;;
    --host) SOURCE_HOST="$2"; shift 2 ;;
    --port) SOURCE_PORT="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    *) usage ;;
  esac
done

[[ -n "$DEST" ]] || usage
"$SCRIPT_DIR/recovery-path-guard.sh" "$DEST"

TS=$(date -u +"%Y-%m-%dT%H%M%SZ")
OUT="${DEST%/}/${TS}"
PG_VER=$(psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d postgres -tAc "SHOW server_version_num;" 2>/dev/null || echo "unknown")

echo "create-base-backup: execute=$EXECUTE out=$OUT pg=$PG_VER"
df -h "$DEST" || true

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN: would run pg_basebackup -h $SOURCE_HOST -p $SOURCE_PORT -D $OUT/data -Fp -Xs -P (no -R)"
  exit 0
fi

mkdir -p "$OUT"
START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_LSN=$(psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d postgres -tAc "SELECT pg_current_wal_lsn();")
SYSID=$(psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d postgres -tAc "SELECT system_identifier FROM pg_control_system();" 2>/dev/null || echo "unknown")
TL=$(psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();" 2>/dev/null || echo "unknown")
# Do not pass -R: PITR base backups must not create standby.signal / primary_conninfo.
pg_basebackup -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -D "$OUT/data" -Fp -Xs -P
END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
END_LSN=$(psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$SOURCE_USER" -d postgres -tAc "SELECT pg_current_wal_lsn();")
rm -f "$OUT/data/standby.signal"
sed -i '/^primary_conninfo/d' "$OUT/data/postgresql.auto.conf" 2>/dev/null || true

cat > "$OUT/metadata.json" <<EOF
{"postgres_version_num":"$PG_VER","source":"$SOURCE_HOST:$SOURCE_PORT","start":"$START","end":"$END","start_lsn":"$START_LSN","end_lsn":"$END_LSN","system_identifier":"$SYSID","timeline":"$TL"}
EOF
( cd "$OUT/data" && find . -type f -print0 | xargs -0 sha256sum ) > "$OUT/checksums.sha256" 2>/dev/null || true
echo "ok" > "$OUT/SUCCESS"
echo "Base backup complete: $OUT"
