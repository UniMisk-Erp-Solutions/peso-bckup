#!/usr/bin/env bash
# Rejoin old primary (.46) as standby of new primary (.68) — dry-run default.
set -euo pipefail
EXECUTE=0
METHOD="${REJOIN_METHOD:-auto}" # auto|pg_rewind|basebackup

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --method) METHOD="$2"; shift 2 ;;
    *) echo "Usage: $0 [--execute] [--method pg_rewind|basebackup|auto]"; exit 1 ;;
  esac
done

echo "rejoin-old-primary: execute=$EXECUTE method=$METHOD"

checksums=$(psql -h 192.168.23.46 -p 5432 -U supabase_admin -d postgres -tAc "SHOW data_checksums;" 2>/dev/null || echo unknown)
hints=$(psql -h 192.168.23.46 -p 5432 -U supabase_admin -d postgres -tAc "SHOW wal_log_hints;" 2>/dev/null || echo unknown)
echo "data_checksums=$checksums wal_log_hints=$hints"

if [[ "$checksums" == "off" && "$hints" == "off" ]]; then
  echo "pg_rewind: NOT SAFE (need data_checksums=on or wal_log_hints=on)"
  METHOD=basebackup
fi

echo "Recommended path: $METHOD"

if [[ "$METHOD" == "pg_rewind" ]]; then
  echo "Would: stop .46 postgres → pg_rewind --source-server=... → standby.signal → start"
elif [[ "$METHOD" == "basebackup" ]]; then
  echo "Would: stop .46 postgres → pg_basebackup from .68 → configure primary_conninfo → start standby"
fi

[[ "$EXECUTE" -eq 1 ]] && { echo "BLOCKED: run only during approved failback window"; exit 2; }
echo "DRY RUN complete"
exit 0
