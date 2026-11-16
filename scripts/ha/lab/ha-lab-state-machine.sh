#!/usr/bin/env bash
# Priyanshu HA lab — in-memory state machine (no production hosts).
set -euo pipefail

LAB_ROOT="${PESOWISE_HA_LAB_ROOT:-${TMPDIR:-/tmp}/pesowise-ha-lab}"
STATE_FILE="$LAB_ROOT/state.env"
HISTORY="$LAB_ROOT/history.log"
mkdir -p "$LAB_ROOT"

# Lab-only guard: block accidental production IP usage in lab scripts
export PESOWISE_HA_LAB=1

default_state() {
  cat >"$STATE_FILE" <<'EOF'
HA_PHASE=NORMAL
VIP_OWNER=46
DB_PRIMARY=46
DB_STANDBY=68
PG_46_WRITABLE=1
PG_68_WRITABLE=0
FENCED_46=0
FENCED_68=0
APP_46_UP=1
APP_68_UP=1
HAPROXY_UP=1
REPL_STREAMING=1
REPL_LAG_SEC=0
EOF
}

[[ -f "$STATE_FILE" ]] || default_state
# shellcheck disable=SC1090
source "$STATE_FILE"

log_event() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$HISTORY"
}

count_writable() {
  local n=0
  [[ "${PG_46_WRITABLE:-0}" == "1" ]] && n=$((n + 1))
  [[ "${PG_68_WRITABLE:-0}" == "1" ]] && n=$((n + 1))
  echo "$n"
}

assert_single_primary() {
  local w
  w=$(count_writable)
  if [[ "$w" -gt 1 ]]; then
    echo "SPLIT_BRAIN: writable_primaries=$w (46=$PG_46_WRITABLE 68=$PG_68_WRITABLE)" >&2
    return 1
  fi
  return 0
}

persist() {
  assert_single_primary || exit 2
  cat >"$STATE_FILE" <<EOF
HA_PHASE=$HA_PHASE
VIP_OWNER=$VIP_OWNER
DB_PRIMARY=$DB_PRIMARY
DB_STANDBY=$DB_STANDBY
PG_46_WRITABLE=$PG_46_WRITABLE
PG_68_WRITABLE=$PG_68_WRITABLE
FENCED_46=$FENCED_46
FENCED_68=$FENCED_68
APP_46_UP=$APP_46_UP
APP_68_UP=$APP_68_UP
HAPROXY_UP=$HAPROXY_UP
REPL_STREAMING=$REPL_STREAMING
REPL_LAG_SEC=$REPL_LAG_SEC
EOF
}

cmd="${1:-status}"
shift || true

case "$cmd" in
  reset)
    default_state
    : >"$HISTORY"
    log_event "reset NORMAL"
    persist
    echo "OK reset"
    ;;
  status)
    persist
    echo "phase=$HA_PHASE vip=$VIP_OWNER db_primary=$DB_PRIMARY db_standby=$DB_STANDBY"
    echo "pg46_writable=$PG_46_WRITABLE pg68_writable=$PG_68_WRITABLE fenced46=$FENCED_46 fenced68=$FENCED_68"
    echo "app46=$APP_46_UP app68=$APP_68_UP repl=$REPL_STREAMING lag=${REPL_LAG_SEC}s"
    ;;
  simulate-app46-down)
    APP_46_UP=0
    log_event "app46_down"
    persist
    echo "OK app46 down (haproxy should prefer app68)"
    ;;
  simulate-haproxy-backend-fail)
    APP_46_UP=0
    log_event "haproxy_backend46_fail"
    persist
    echo "OK haproxy backend46 marked down"
    ;;
  simulate-vip-owner-down)
    VIP_OWNER=46
    APP_46_UP=0
    log_event "vip_owner46_unreachable"
    persist
    echo "OK vip owner46 unhealthy (keepalived would move VIP)"
    ;;
  simulate-keepalived-failover-to-68)
    if [[ "$APP_68_UP" != "1" ]]; then echo "FAIL: app68 down"; exit 1; fi
    VIP_OWNER=68
    HA_PHASE="${HA_PHASE}_VIP_ON_68" 
    [[ "$HA_PHASE" == "NORMAL_VIP_ON_68" ]] || HA_PHASE="FAILOVER_VIP"
    log_event "keepalived vip->68"
    persist
    echo "OK vip=68"
    ;;
  simulate-pg46-down)
    if [[ "$PG_46_WRITABLE" == "1" && "$FENCED_46" != "1" ]]; then
      echo "REFUSE: fence .46 before simulating pg down while writable" >&2
      exit 1
    fi
    REPL_STREAMING=0
    log_event "pg46_down"
    persist
    echo "OK pg46 unreachable"
    ;;
  fence-46)
    FENCED_46=1
    PG_46_WRITABLE=0
    REPL_STREAMING=0
    log_event "fence46"
    persist
    echo "OK fenced46 writable=0"
    ;;
  fence-68)
    FENCED_68=1
    PG_68_WRITABLE=0
    log_event "fence68"
    persist
    echo "OK fenced68"
    ;;
  promote-68)
    if [[ "$FENCED_46" != "1" ]]; then
      echo "REFUSE promote: .46 not fenced (split-brain risk)" >&2
      exit 1
    fi
    if [[ "$PG_68_WRITABLE" == "1" ]]; then
      echo "REFUSE: .68 already writable" >&2
      exit 1
    fi
    DB_PRIMARY=68
    DB_STANDBY=46
    PG_68_WRITABLE=1
    PG_46_WRITABLE=0
    HA_PHASE=PROMOTED_68
    REPL_STREAMING=0
    log_event "promote68"
    persist
    echo "OK primary=68"
    ;;
  app-reconnect-68)
    log_event "app_db_endpoint->68"
    persist
    echo "OK app uses db68"
    ;;
  simulate-46-return)
    FENCED_46=0
    APP_46_UP=1
    HA_PHASE=REJOIN_PENDING
    log_event "node46_return"
    persist
    echo "OK .46 back (not primary yet)"
    ;;
  rejoin-46-as-standby)
    if [[ "$DB_PRIMARY" != "68" ]]; then echo "FAIL: primary must be 68"; exit 1; fi
    PG_46_WRITABLE=0
    PG_68_WRITABLE=1
    DB_STANDBY=46
    REPL_STREAMING=1
    REPL_LAG_SEC=120
    HA_PHASE=REJOINING
    log_event "rejoin46_standby lag=120"
    persist
    echo "OK .46 standby catching up"
    ;;
  catchup-complete)
    if [[ "$REPL_LAG_SEC" -gt 0 ]]; then REPL_LAG_SEC=0; fi
    HA_PHASE=SYNCED
    log_event "catchup_complete"
    persist
    echo "OK lag=0"
    ;;
  failback-promote-46)
    if [[ "$DB_PRIMARY" != "68" ]]; then echo "FAIL: expected 68 primary"; exit 1; fi
    if [[ "$REPL_LAG_SEC" != "0" ]]; then echo "REFUSE failback: lag not zero"; exit 1; fi
    PG_68_WRITABLE=0
    PG_46_WRITABLE=1
    DB_PRIMARY=46
    DB_STANDBY=68
    REPL_STREAMING=1
    VIP_OWNER=46
    HA_PHASE=NORMAL
    log_event "failback primary=46"
    persist
    echo "OK normal .46 primary"
    ;;
  rejoin-68-as-standby)
    PG_68_WRITABLE=0
    DB_STANDBY=68
    REPL_STREAMING=1
    log_event "rejoin68_standby"
    persist
    echo "OK .68 standby"
    ;;
  attempt-unsafe-dual-write)
    PG_46_WRITABLE=1
    PG_68_WRITABLE=1
    log_event "UNSAFE dual write attempt"
    if ! persist 2>/dev/null; then
      PG_68_WRITABLE=0
      persist
      echo "BLOCKED split-brain"
      exit 3
    fi
    ;;
  *)
    echo "Usage: $0 {reset|status|fence-46|promote-68|failback-promote-46|...}" >&2
    exit 1
    ;;
esac
