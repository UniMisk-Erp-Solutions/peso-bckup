#!/usr/bin/env bash
# Read-only replication verification from .68 (uses local container env, no secrets printed).
set -euo pipefail

PRIMARY="${PRIMARY_HOST:-192.168.23.46}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk

run_sudo() { echo "${SUDO_PASSWORD:-qwertyui}" | sudo -S "$@"; }

PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)

q_primary() {
  run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
    psql -h "$PRIMARY" -p 5432 -U supabase_admin -d postgres -At -c "$1"
}

echo "=== PRIMARY (.46) ==="
echo -n "pg_is_in_recovery: "; q_primary "SELECT pg_is_in_recovery();"
echo -n "system_identifier: "; q_primary "SELECT system_identifier FROM pg_control_system();"
echo -n "current_wal_lsn: "; q_primary "SELECT pg_current_wal_lsn();"
echo "pg_stat_replication (.68):"
q_primary "SELECT application_name, state, sync_state, sent_lsn, write_lsn, flush_lsn, replay_lsn, COALESCE(replay_lag::text,'') FROM pg_stat_replication WHERE client_addr = '192.168.23.68';"
echo "replication_slots:"
q_primary "SELECT slot_name, slot_type, active, restart_lsn FROM pg_replication_slots ORDER BY slot_name;"

echo ""
echo "=== STANDBY (.68 local) ==="
run_sudo docker exec "$DB" psql -U postgres -d postgres -At -c "SELECT pg_is_in_recovery();"
run_sudo docker exec "$DB" psql -U postgres -d postgres -At -c "SELECT system_identifier FROM pg_control_system();"
run_sudo docker exec "$DB" psql -U postgres -d postgres -x -c "SELECT pid, status, slot_name, written_lsn, flushed_lsn, latest_end_lsn FROM pg_stat_wal_receiver;"
run_sudo docker exec "$DB" psql -U postgres -d postgres -At -c "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(), now() - pg_last_xact_replay_timestamp();"

echo ""
echo "=== SPOT COUNTS (may differ slightly while live) ==="
for t in expenses organizations notifications; do
  pc=$(q_primary "SELECT count(*) FROM public.${t};" 2>/dev/null || echo NA)
  sc=$(run_sudo docker exec "$DB" psql -U postgres -d postgres -At -c "SELECT count(*) FROM public.${t};" 2>/dev/null || echo NA)
  echo "${t}: primary=${pc} standby=${sc}"
done
