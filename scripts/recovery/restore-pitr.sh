#!/usr/bin/env bash
# Restore PostgreSQL to recovery_target_time into ISOLATED target-dir only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXECUTE=0
BASE=""
WAL=""
TARGET_TIME=""
TARGET_DIR=""
RECOVERY_ID=$(uuidgen 2>/dev/null || echo "recovery-$(date +%s)")

usage() { echo "Usage: $0 --base-backup PATH --wal-dir PATH --target-time TS --target-dir PATH [--execute]"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-backup) BASE="$2"; shift 2 ;;
    --wal-dir) WAL="$2"; shift 2 ;;
    --target-time) TARGET_TIME="$2"; shift 2 ;;
    --target-dir) TARGET_DIR="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    *) usage ;;
  esac
done

[[ -n "$BASE" && -n "$WAL" && -n "$TARGET_TIME" && -n "$TARGET_DIR" ]] || usage
bash "$SCRIPT_DIR/recovery-path-guard.sh" "$TARGET_DIR"
[[ -d "$BASE" ]] || { echo "missing base backup"; exit 1; }
[[ -d "$WAL" ]] || { echo "missing wal dir"; exit 1; }

MANIFEST="$TARGET_DIR/recovery_manifest.json"
write_manifest() {
  local st="$1"
  printf '{"recovery_id":"%s","base_backup":"%s","target_time":"%s","wal_dir":"%s","status":"%s","recovery_data_dir":"%s"}\n' \
    "$RECOVERY_ID" "$BASE" "$TARGET_TIME" "$WAL" "$st" "$TARGET_DIR" > "$MANIFEST"
}

write_manifest PRECHECK
echo "restore-pitr: execute=$EXECUTE target_time=$TARGET_TIME"

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN: would copy base to $TARGET_DIR/pgdata, configure recovery.signal, recovery_target_time=$TARGET_TIME"
  exit 0
fi

if [[ -e "$TARGET_DIR/pgdata" ]]; then
  echo "refusing non-empty target pgdata"; exit 1
fi
mkdir -p "$TARGET_DIR/pgdata"
rsync -a "$BASE/" "$TARGET_DIR/pgdata/" 2>/dev/null || cp -a "$BASE/." "$TARGET_DIR/pgdata/"
rm -f "$TARGET_DIR/pgdata/standby.signal"
sed -i '/^primary_conninfo/d' "$TARGET_DIR/pgdata/postgresql.auto.conf" 2>/dev/null || true

# WAL_DIR must be mounted at the same path inside the recovery postgres (e.g. -v WAL_DIR:/pitr-wal:ro).
WAL_MOUNT="${WAL_MOUNT:-/pitr-wal}"
cat >> "$TARGET_DIR/pgdata/postgresql.auto.conf" <<EOF
restore_command = 'cp ${WAL_MOUNT}/%f %p'
recovery_target_time = '$TARGET_TIME'
recovery_target_inclusive = on
recovery_target_action = 'promote'
EOF
touch "$TARGET_DIR/pgdata/recovery.signal"
write_manifest RESTORING
echo "Restore configured. Start postgres with PGDATA=$TARGET_DIR/pgdata (isolated port). See PITR_RUNBOOK.md"
exit 0
