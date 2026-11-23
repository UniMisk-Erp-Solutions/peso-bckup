#!/usr/bin/env bash
# PITR health: archive on .68, slot lives on .46 primary.
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:-}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
PRIMARY=192.168.23.46
SLOT=pesowise_pitr
WAL_DIR=/var/lib/docker/volumes/ypwzkftxvvbjfvsll1y3aesk_supabase-db-config/_data/pitr-wal
BASE_DIR=/var/lib/pesowise-pitr-backup/base
FAIL=0

run_sudo() {
  if [[ -n "$SUDO_PASS" ]]; then echo "$SUDO_PASS" | sudo -S "$@"; else sudo "$@"; fi
}

pass() { echo "$1: PASS"; }
fail() { echo "$1: FAIL"; FAIL=1; }

PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)

echo "PESOWISE PITR HEALTH (.68 archive, .46 primary)"
echo "================================================"

run_sudo docker exec "$DB" pg_isready -U postgres -q && pass "Postgres (.68 standby up)" || fail "Postgres"

slot=$(run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
  psql -h "$PRIMARY" -p 5432 -U supabase_admin -d postgres -tAc \
  "SELECT active FROM pg_replication_slots WHERE slot_name='$SLOT';" 2>/dev/null || echo "")
[[ "$slot" == "t" ]] && pass "PITR slot on .46 ($SLOT active)" || fail "PITR slot on .46"

run_sudo docker exec "$DB" pgrep -f "pg_receivewal.*$SLOT" >/dev/null && pass "pg_receivewal on .68" || fail "pg_receivewal on .68"

latest_base=$(run_sudo find "$BASE_DIR" -name SUCCESS 2>/dev/null | head -1)
[[ -n "$latest_base" ]] && pass "Base backup on .68" || fail "Base backup on .68"

wal_n=$(run_sudo find "$WAL_DIR" -maxdepth 1 -type f ! -name '*.partial' 2>/dev/null | wc -l)
[[ "${wal_n:-0}" -gt 0 ]] && pass "WAL files on .68 ($wal_n)" || fail "WAL files on .68"

echo "================================================"
[[ "$FAIL" -eq 0 ]] && echo "OVERALL: PASS" || echo "OVERALL: FAIL"
exit "$FAIL"
