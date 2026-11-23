#!/usr/bin/env bash
# Sample replication metrics for PRE_FAILOVER_STABILITY_REPORT (run on .68).
set -euo pipefail

PRIMARY="${PRIMARY_HOST:-192.168.23.46}"
INTERVAL_SEC="${INTERVAL_SEC:-300}"
DURATION_MIN="${DURATION_MIN:-60}"
OUT="${OUT:-/tmp/pre-failover-stability.tsv}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk

run_sudo() { echo "${SUDO_PASSWORD:?Set SUDO_PASSWORD}" | sudo -S "$@"; }

PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)

q_primary() {
  run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
    psql -h "$PRIMARY" -p 5432 -U supabase_admin -d postgres -At -c "$1"
}

end=$((SECONDS + DURATION_MIN * 60))
echo -e "ts\tprimary_lsn\tstandby_receive\tstandby_replay\treplay_age_sec\twal_rx_status\treconnect_note" | tee "$OUT"

last_rx=""
reconnects=0

while [[ "$SECONDS" -lt "$end" ]]; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  plsn=$(q_primary "SELECT pg_current_wal_lsn();")
  srecv=$(run_sudo docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT pg_last_wal_receive_lsn();")
  srepl=$(run_sudo docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT pg_last_wal_replay_lsn();")
  age=$(run_sudo docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT COALESCE(EXTRACT(EPOCH FROM (now()-pg_last_xact_replay_timestamp()))::numeric,9999);")
  st=$(run_sudo docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT COALESCE(status,'none') FROM pg_stat_wal_receiver;")
  if [[ -n "$last_rx" && "$st" != "$last_rx" && "$last_rx" != "none" ]]; then
    reconnects=$((reconnects + 1))
  fi
  last_rx="$st"
  echo -e "${ts}\t${plsn}\t${srecv}\t${srepl}\t${age}\t${st}\t${reconnects}" | tee -a "$OUT"
  sleep "$INTERVAL_SEC"
done

echo "DONE samples=$(wc -l < "$OUT") reconnects=$reconnects file=$OUT"
