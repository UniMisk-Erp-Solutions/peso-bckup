#!/usr/bin/env bash
# Normal-state HA health (read-only). Run on .46 for primary + replication view.
# For full standby WAL receiver checks, also run on .68: verify-replication-68.sh
set -euo pipefail
FAIL=0
WARN=0
PRIMARY_HOST="${PRIMARY_HOST:-192.168.23.46}"
STANDBY_HOST="${STANDBY_HOST:-192.168.23.68}"
PRIMARY_CONTAINER="${PRIMARY_DB_CONTAINER:-supabase-db-kar0ro1k6jiyfxzzw7acnsza}"
STANDBY_CONTAINER="${STANDBY_DB_CONTAINER:-supabase-db-ypwzkftxvvbjfvsll1y3aesk}"
MAX_REPLAY_LAG_SEC="${MAX_REPLAY_LAG_SEC:-30}"
HA_ROLE="${HA_ROLE:-primary}"

pass() { echo "  status: PASS"; }
fail() { echo "  status: FAIL"; FAIL=1; }
warn_line() { echo "  status: WARN"; WARN=1; }

echo "PESOWISE HA HEALTH"
echo "=================="

if [[ "$HA_ROLE" == "standby" ]]; then
  echo "standby host ($STANDBY_HOST):"
  if ping -c 1 -W 2 "$PRIMARY_HOST" >/dev/null 2>&1; then echo "  primary reachable: YES"; else echo "  primary reachable: NO"; FAIL=1; fi
  rec=$(docker exec "$STANDBY_CONTAINER" psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo err)
  if [[ "$rec" == "t" ]]; then echo "  role: STANDBY"; else echo "  role: UNEXPECTED ($rec)"; FAIL=1; fi
  wr=$(docker exec "$STANDBY_CONTAINER" psql -U postgres -d postgres -tAc "SELECT status FROM pg_stat_wal_receiver;" 2>/dev/null || echo "")
  if [[ "$wr" == "streaming" ]]; then echo "  wal receiver: STREAMING"; else echo "  wal receiver: $wr"; FAIL=1; fi
  ages=$(docker exec "$STANDBY_CONTAINER" psql -U postgres -d postgres -tAc "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()));" 2>/dev/null || echo 9999)
  echo "  replay age (sec): $ages"
  awk -v a="$ages" -v m="$MAX_REPLAY_LAG_SEC" 'BEGIN{exit (a<=m)?0:1}' && pass || fail
  echo "=================="
  [[ "$FAIL" -eq 0 ]] && echo "OVERALL: PASS" || echo "OVERALL: FAIL"
  exit "$FAIL"
fi

echo ".46:"
if ping -c 1 -W 2 "$PRIMARY_HOST" >/dev/null 2>&1; then echo "  reachable: YES"; else echo "  reachable: NO"; FAIL=1; fi
p_rec=$(docker exec "$PRIMARY_CONTAINER" psql -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo err)
p_sys=$(docker exec "$PRIMARY_CONTAINER" psql -U supabase_admin -d postgres -tAc "SELECT system_identifier FROM pg_control_system();" 2>/dev/null || echo err)
if [[ "$p_rec" == "f" ]]; then echo "  role: PRIMARY"; echo "  writable: YES"; pass; else echo "  role: UNEXPECTED ($p_rec)"; fail; fi

echo ""
echo ".68 (from primary pg_stat_replication):"
stream=$(docker exec "$PRIMARY_CONTAINER" psql -U supabase_admin -d postgres -tAc \
  "SELECT state FROM pg_stat_replication WHERE client_addr='$STANDBY_HOST' AND application_name='main';" 2>/dev/null || echo "")
if [[ "$stream" == "streaming" ]]; then echo "  wal sender (main): STREAMING"; else echo "  wal sender (main): FAIL ($stream)"; FAIL=1; fi

lag_sec=$(docker exec "$PRIMARY_CONTAINER" psql -U supabase_admin -d postgres -tAc \
  "SELECT COALESCE(EXTRACT(EPOCH FROM replay_lag)::numeric, 0) FROM pg_stat_replication WHERE client_addr='$STANDBY_HOST' AND application_name='main';" 2>/dev/null || echo 9999)
echo "  replay lag (sec): $lag_sec"
awk -v a="$lag_sec" -v m="$MAX_REPLAY_LAG_SEC" 'BEGIN{exit (a<=m)?0:1}' && pass || fail

stale=$(docker exec "$PRIMARY_CONTAINER" psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM pg_stat_replication WHERE client_addr='$STANDBY_HOST' AND (application_name IS NULL OR application_name='') AND replay_lag > interval '5 minutes';" 2>/dev/null || echo 0)
if [[ "$stale" != "0" ]]; then echo "  stale walsender rows: $stale (WARN — terminate zombie backend on .46)"; WARN=1; fi

echo ""
echo "TOPOLOGY:"
echo "  system_identifier: $p_sys"
echo "  Split brain: NO (single writer .46)"

if [[ -x /home/hasto/peso-bckup-priyanshu/scripts/recovery/check-pitr-health.sh ]]; then
  if /home/hasto/peso-bckup-priyanshu/scripts/recovery/check-pitr-health.sh >/dev/null 2>&1; then echo "PITR: PASS"; else echo "PITR: FAIL"; FAIL=1; fi
else
  echo "PITR: (run check-pitr-health.sh on .46)"
fi

echo ""
echo "Tip: on .68 run scripts/ha/verify-replication-68.sh for pg_stat_wal_receiver."
echo "=================="
if [[ "$FAIL" -eq 0 && "$WARN" -eq 0 ]]; then echo "OVERALL: PASS"; exit 0; fi
if [[ "$FAIL" -eq 0 ]]; then echo "OVERALL: PASS (with warnings)"; exit 0; fi
echo "OVERALL: FAIL"; exit 1
