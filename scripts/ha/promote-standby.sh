#!/usr/bin/env bash
# Promote .68 standby to primary — DRY RUN by default. Manual HA only.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTE=0
STANDBY_DB_CONTAINER="${STANDBY_DB_CONTAINER:-supabase-db-ypwzkftxvvbjfvsll1y3aesk}"
CONFIRM="${PESOWISE_HA_PROMOTE_CONFIRM:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    *) echo "Unknown arg $1"; exit 1 ;;
  esac
done

echo "promote-standby: execute=$EXECUTE container=$STANDBY_DB_CONTAINER"
echo "Run ON standby host (192.168.23.68) after fencing .46."

echo "Step 1: acquire HA lock (management host)"
echo "  $SCRIPT_DIR/ha-lock.sh acquire --operator YOU --reason promote"

echo "Step 2: safety checks"
echo "  RUN_LOCALLY=standby $SCRIPT_DIR/check-failover-safety.sh"

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN: would run pg_promote() inside $STANDBY_DB_CONTAINER"
  exit 0
fi

[[ "$CONFIRM" == "PROMOTE_STANDBY_NOW" ]] || {
  echo "Refusing: set PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW" >&2
  exit 1
}

RUN_LOCALLY=standby "$SCRIPT_DIR/check-failover-safety.sh" || exit 1

BEFORE=$(sudo docker exec "$STANDBY_DB_CONTAINER" psql -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn();")
echo "Before: $BEFORE"

sudo docker exec "$STANDBY_DB_CONTAINER" psql -U supabase_admin -d postgres -tAc "SELECT pg_promote(true);"

sleep 3
AFTER=$(sudo docker exec "$STANDBY_DB_CONTAINER" psql -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery(), pg_current_wal_lsn(), (SELECT timeline_id FROM pg_control_checkpoint());")
echo "After: $AFTER"

if echo "$AFTER" | grep -q '^f|'; then
  echo "PROMOTION SUCCESS"
  exit 0
fi

echo "PROMOTION FAIL"
exit 1
