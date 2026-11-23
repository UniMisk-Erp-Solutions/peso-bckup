#!/usr/bin/env bash
# Run full Priyanshu HA lifecycle tests (local simulator only).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SM="$SCRIPT_DIR/ha-lab-state-machine.sh"
export PESOWISE_HA_LAB=1
export PESOWISE_HA_LAB_ROOT="${PESOWISE_HA_LAB_ROOT:-${TMPDIR:-/tmp}/pesowise-ha-lab-test-$$}"

pass=0
fail=0

ok() { echo "PASS: $1"; pass=$((pass + 1)); }
bad() { echo "FAIL: $1"; fail=$((fail + 1)); }

run() {
  if "$SM" "$@"; then return 0; fi
  return 1
}

assert_status() {
  local needle="$1"
  if "$SM" status | grep -q "$needle"; then ok "$needle"; else bad "missing $needle"; fi
}

echo "=== Priyanshu HA lab tests root=$PESOWISE_HA_LAB_ROOT ==="

run reset || { bad reset; exit 1; }
assert_status "phase=NORMAL"
assert_status "db_primary=46"
assert_status "pg68_writable=0"

run simulate-app46-down && ok "1 app46 down"
run simulate-haproxy-backend-fail && ok "2 haproxy backend fail"
run simulate-vip-owner-down && ok "3 vip owner fail"
run simulate-keepalived-failover-to-68 && assert_status "vip=68"

run fence-46 && ok "4 fence46 before pg promote"
run promote-68 && assert_status "db_primary=68" && assert_status "pg46_writable=0"
run app-reconnect-68 && ok "5 app reconnect"

run simulate-46-return && ok "6 node46 return"
run rejoin-46-as-standby && assert_status "db_standby=46"
run catchup-complete && assert_status "lag=0s"

run failback-promote-46 && assert_status "phase=NORMAL" && assert_status "db_primary=46"
run rejoin-68-as-standby && assert_status "pg68_writable=0"

if run attempt-unsafe-dual-write; then bad "split-brain should block"; else ok "11 split-brain blocked"; fi

run reset
if "$SM" status | grep -q 'pg46_writable=1' && "$SM" status | grep -q 'pg68_writable=0'; then
  ok "12 single writable invariant (46 primary)"
else
  bad "12 writable flags wrong after reset"
fi

echo "=== RESULT pass=$pass fail=$fail ==="
[[ "$fail" -eq 0 ]] || exit 1
echo "ALL_LAB_TESTS_PASS"
