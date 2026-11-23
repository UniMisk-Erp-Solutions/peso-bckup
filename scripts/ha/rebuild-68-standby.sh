#!/usr/bin/env bash
# Run ON .68 as user with sudo (mithil). Does not log passwords.
set -euo pipefail

DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
VOL=/var/lib/docker/volumes/ypwzkftxvvbjfvsll1y3aesk_supabase-db-data/_data
PRES="/var/lib/docker/volumes/ypwzkftxvvbjfvsll1y3aesk_supabase-db-data/_data.preserved-20260925T095317Z"

run_sudo() {
  echo "${SUDO_PASSWORD:?Set SUDO_PASSWORD for sudo on .68}" | sudo -S "$@"
}

if ! run_sudo test -f "$PRES/postgresql.auto.conf"; then
  echo "WARN: no preserved PGDATA; using fresh standby auto.conf only"
fi
echo "Using preserved: ${PRES:-none}"

DB_LOCAL=supabase-db-ypwzkftxvvbjfvsll1y3aesk
PP=$(run_sudo docker inspect "$DB_LOCAL" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
if [[ -z "$PP" ]]; then
  echo "ERROR: could not read POSTGRES_PASSWORD from local DB container env" >&2
  exit 1
fi
PW="$PP"

test_repl_auth() {
  run_sudo env PGPASSWORD="$1" docker run --rm --network host -e PGPASSWORD \
    supabase/postgres:15.8.1.085 \
    pg_basebackup -h 192.168.23.46 -p 5432 -U replicator -D /tmp/bbauth -Fp -Xs -S pesowise_68_standby -n >/dev/null 2>&1
}

if ! test_repl_auth "$PW"; then
  echo "replicator auth failed — syncing password on .46 from supabase_admin ..."
  run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
    psql -h 192.168.23.46 -p 5432 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER USER replicator WITH PASSWORD '$PW';"
  test_repl_auth "$PW" || { echo "ERROR: replicator still cannot authenticate" >&2; exit 1; }
fi
echo "replicator OK (password length ${#PW})"

# Legacy preserved conninfo merge (optional)
PRES="/var/lib/docker/volumes/ypwzkftxvvbjfvsll1y3aesk_supabase-db-data/_data.preserved-20260925T095317Z"
if run_sudo test -f "$PRES/postgresql.auto.conf"; then
  echo "Using preserved auto.conf from: $PRES"
else
  PRES=""
fi

run_sudo pkill -f 'pg_basebackup -h 192.168.23.46' || true
sleep 2

run_sudo find "$VOL" -mindepth 1 -delete
run_sudo chown -R 105:106 "$VOL"

echo "Starting pg_basebackup from 192.168.23.46 (this may take several minutes) ..."
run_sudo env PGPASSWORD="$PW" docker run --rm --network host \
  -e PGPASSWORD \
  -v "$VOL:/var/lib/postgresql/data" \
  supabase/postgres:15.8.1.085 \
  pg_basebackup -h 192.168.23.46 -p 5432 -U replicator \
  -D /var/lib/postgresql/data -Fp -Xs -P -R -S pesowise_68_standby

# -R writes standby.signal + primary_conninfo; merge preserved auto.conf for Supabase settings
if [[ -n "$PRES" ]] && run_sudo test -f "$PRES/postgresql.auto.conf"; then
  run_sudo cp "$PRES/postgresql.auto.conf" "$VOL/postgresql.auto.conf"
fi
run_sudo touch "$VOL/standby.signal"
run_sudo bash -c "grep -v '^primary_slot_name' '$VOL/postgresql.auto.conf' > /tmp/pga.conf"
run_sudo bash -c "echo \"primary_slot_name = 'pesowise_68_standby'\" >> /tmp/pga.conf"
run_sudo cp /tmp/pga.conf "$VOL/postgresql.auto.conf"
if ! run_sudo grep -q '^hot_standby = on' "$VOL/postgresql.conf" 2>/dev/null; then
  echo "hot_standby = on" | run_sudo tee -a "$VOL/postgresql.conf" >/dev/null
fi
run_sudo chown -R 105:106 "$VOL"

run_sudo du -sh "$VOL"

run_sudo docker start "$DB"
for _ in $(seq 1 60); do
  if run_sudo docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

echo "--- standby checks ---"
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery();"
run_sudo docker exec "$DB" psql -U postgres -d postgres -x -c "SELECT * FROM pg_stat_wal_receiver;"
run_sudo docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"
