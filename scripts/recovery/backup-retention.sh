#!/usr/bin/env bash
# Identify old verified base backups and WAL safe to prune. DEFAULT: dry-run only.
set -euo pipefail

EXECUTE=0
BASE_ROOT="${BASE_ROOT:-/var/lib/pesowise-pitr-backup/base}"
WAL_DIR="${WAL_DIR:-}"
KEEP_BASE_DAYS="${KEEP_BASE_DAYS:-14}"
KEEP_WAL_HOURS_BEYOND_OLDEST_BASE="${KEEP_WAL_HOURS_BEYOND_OLDEST_BASE:-24}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --base-root) BASE_ROOT="$2"; shift 2 ;;
    --wal-dir) WAL_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg $1"; exit 1 ;;
  esac
done

echo "backup-retention: execute=$EXECUTE base_root=$BASE_ROOT wal_dir=${WAL:-none}"

mapfile -t VERIFIED < <(find "$BASE_ROOT" -maxdepth 2 -name SUCCESS -printf '%h\n' 2>/dev/null | sort)
if [[ ${#VERIFIED[@]} -eq 0 ]]; then
  echo "No verified base backups under $BASE_ROOT"
  exit 0
fi

OLDEST_BASE="${VERIFIED[0]}"
echo "Oldest verified base backup: $OLDEST_BASE"
echo "Would keep at least ${KEEP_BASE_DAYS}d of base backups and WAL through oldest recoverable chain."

for dir in "${VERIFIED[@]}"; do
  age_days=$(( ( $(date +%s) - $(stat -c %Y "$dir" 2>/dev/null || stat -f %m "$dir") ) / 86400 ))
  if [[ "$age_days" -gt "$KEEP_BASE_DAYS" ]]; then
    echo "CANDIDATE base prune: $dir (age ${age_days}d)"
    [[ "$EXECUTE" -eq 1 ]] && echo "SKIP delete: --execute not yet implemented for safety" && exit 2
  fi
done

if [[ -n "$WAL_DIR" && -d "$WAL_DIR" ]]; then
  echo "WAL dir $WAL_DIR — no automatic WAL deletion in this script (dry-run only)."
fi

echo "DRY RUN complete. No files removed."
