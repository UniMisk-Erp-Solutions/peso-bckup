#!/usr/bin/env bash
# Refuse promotion unless fencing and catch-up criteria are met (manual HA).
set -euo pipefail

PRIMARY_HOST="${PRIMARY_HOST:-192.168.23.46}"
STANDBY_HOST="${STANDBY_HOST:-192.168.23.68}"
PRIMARY_DB_CONTAINER="${PRIMARY_DB_CONTAINER:-supabase-db-kar0ro1k6jiyfxzzw7acnsza}"
STANDBY_DB_CONTAINER="${STANDBY_DB_CONTAINER:-supabase-db-ypwzkftxvvbjfvsll1y3aesk}"
MAX_REPLAY_LAG_SEC="${MAX_REPLAY_LAG_SEC:-30}"
MAX_BYTE_LAG_MB="${MAX_BYTE_LAG_MB:-64}"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    *) shift ;;
  esac
done

if [[ "$FORCE" -eq 1 ]]; then
  if [[ "${PESOWISE_HA_FORCE_CONFIRM:-}" != "I_ACCEPT_SPLIT_BRAIN_RISK" ]]; then
    echo "REFUSE: --force requires env PESOWISE_HA_FORCE_CONFIRM=I_ACCEPT_SPLIT_BRAIN_RISK" >&2
    exit 2
  fi
  echo "WARN: forced promotion path enabled by operator"
fi

REFUSE=0
reasons=()

ping -c 1 -W 2 "$PRIMARY_HOST" >/dev/null 2>&1 && primary_up=1 || primary_up=0
ping -c 1 -W 2 "$STANDBY_HOST" >/dev/null 2>&1 && standby_up=1 || standby_up=0

echo "=== FAILOVER SAFETY CHECK ==="
echo "primary_host reachable: $primary_up"
echo "standby_host reachable: $standby_up"

if [[ "$primary_up" -eq 1 ]]; then
  primary_rec=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "${PRIMARY_SSH:-hasto@${PRIMARY_HOST}}" \
    "docker exec ${PRIMARY_DB_CONTAINER} psql -U supabase_admin -d postgres -tAc \"SELECT pg_is_in_recovery();\"" 2>/dev/null || echo unreachable)
  echo "primary_postgres: $primary_rec"
  if [[ "$primary_rec" == "f" ]]; then
    if [[ "${PESOWISE_PRIMARY_FENCED:-}" != "1" ]]; then
      reasons+=("Primary Postgres still accepts writes — fence .46 before promotion")
      REFUSE=1
    else
      echo "WARN: primary reachable but PESOWISE_PRIMARY_FENCED=1 set by operator"
    fi
  fi
fi

if [[ "$standby_up" -eq 0 ]]; then
  reasons+=("Standby host unreachable")
  REFUSE=1
fi

# Standby checks: run this script ON the standby host (192.168.23.68) or via SSH keys (no passwords in script).
run_standby_psql() {
  local sql="$1"
  if [[ "${RUN_LOCALLY:-}" == "standby" ]]; then
    sudo docker exec "$STANDBY_DB_CONTAINER" psql -U supabase_admin -d postgres -tAc "$sql"
  elif [[ -n "${STANDBY_SSH:-}" ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=5 "$STANDBY_SSH" \
      "sudo docker exec ${STANDBY_DB_CONTAINER} psql -U supabase_admin -d postgres -tAc \"$sql\""
  else
    echo "unknown"
  fi
}

standby_recovery=$(run_standby_psql "SELECT pg_is_in_recovery();" 2>/dev/null || echo "unknown")

echo "standby pg_is_in_recovery: $standby_recovery"
if [[ "$standby_recovery" != "t" ]]; then
  reasons+=("Standby is not in recovery mode (may already be primary or broken)")
  REFUSE=1
fi

replay_age=$(run_standby_psql "SELECT COALESCE(EXTRACT(EPOCH FROM (now()-pg_last_xact_replay_timestamp()))::int,999999);" 2>/dev/null || echo 999999)
echo "standby replay_age_sec: $replay_age"
if [[ "$replay_age" -gt "$MAX_REPLAY_LAG_SEC" ]]; then
  reasons+=("Replay lag ${replay_age}s exceeds max ${MAX_REPLAY_LAG_SEC}s")
  REFUSE=1
fi

wal_rx=$(run_standby_psql "SELECT count(*) FROM pg_stat_wal_receiver WHERE status = 'streaming';" 2>/dev/null || echo 0)
echo "standby wal_receiver_rows: $wal_rx"
if [[ "$wal_rx" -eq 0 ]]; then
  if [[ "${PESOWISE_PRIMARY_FENCED:-}" == "1" ]] || [[ "${primary_rec:-}" == "unreachable" ]]; then
    echo "standby wal_receiver: inactive (expected after primary fence)"
  else
    reasons+=("No active pg_stat_wal_receiver on standby — streaming may be broken")
    REFUSE=1
  fi
fi

if [[ -f /var/lib/pesowise-ha/operation.lock ]]; then
  echo "ha_lock: present"
else
  reasons+=("HA lock not held — acquire lock before promotion")
  REFUSE=1
fi

if [[ "$REFUSE" -eq 1 && "$FORCE" -eq 0 ]]; then
  echo "RESULT: REFUSE PROMOTION"
  printf ' - %s\n' "${reasons[@]}"
  exit 1
fi

echo "RESULT: PROMOTION ALLOWED (operator must still confirm fencing)"
exit 0
