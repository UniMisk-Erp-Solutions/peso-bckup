#!/usr/bin/env bash
# Post-failover HA health: .68 PRIMARY, .46 STANDBY (PesoWise only). Run on .68 host.
set -euo pipefail
FAIL=0
PRIMARY_HOST="${PRIMARY_HOST:-192.168.23.68}"
STANDBY_HOST="${STANDBY_HOST:-192.168.23.46}"
PRIMARY_CONTAINER="${PRIMARY_DB_CONTAINER:-supabase-db-ypwzkftxvvbjfvsll1y3aesk}"
SUDO_PASS="${SUDO_PASSWORD:-}"
MAX_REPLAY_LAG_SEC="${MAX_REPLAY_LAG_SEC:-30}"

dexec() {
  if docker exec "$PRIMARY_CONTAINER" "$@" 2>/dev/null; then return 0; fi
  [[ -n "$SUDO_PASS" ]] || return 1
  echo "$SUDO_PASS" | sudo -S docker exec "$PRIMARY_CONTAINER" "$@"
}

psql_q() { dexec psql -U supabase_admin -d postgres -tAc "$1"; }

pass() { echo "  status: PASS"; }
fail() { echo "  status: FAIL"; FAIL=1; }

echo "PESOWISE HA HEALTH (post-failover topology)"
echo "==========================================="

echo ".68 PRIMARY:"
p_rec=$(psql_q "SELECT pg_is_in_recovery();" || echo err)
p_sys=$(psql_q "SELECT system_identifier FROM pg_control_system();" || echo err)
if [[ "$p_rec" == "f" ]]; then echo "  role: PRIMARY"; pass; else echo "  role: UNEXPECTED ($p_rec)"; fail; fi

echo ""
echo "  replication clients:"
dexec psql -U supabase_admin -d postgres -x -c \
  "SELECT application_name, client_addr, state, sync_state FROM pg_stat_replication;" || fail

stream=$(psql_q "SELECT state FROM pg_stat_replication WHERE client_addr IN ('$STANDBY_HOST','10.0.2.1') AND application_name='main';" || echo "")
if [[ "$stream" == "streaming" ]]; then echo "  .46 standby (main): STREAMING"; pass; else echo "  .46 standby (main): ${stream:-MISSING}"; fail; fi

echo ""
echo "TOPOLOGY:"
echo "  system_identifier: $p_sys"
echo "  App via HAProxy -> Kong .68:54321 -> Postgres .68"
echo "  Repl proxy: pesowise-repl-proxy.service (192.168.23.68:5432 -> DB container)"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] && echo "OVERALL: PASS" || echo "OVERALL: FAIL"
exit "$FAIL"
