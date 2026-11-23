#!/usr/bin/env bash
# Rebuild .46 as standby from .68 primary (PATH B basebackup). Run ON .46 after promotion.
set -euo pipefail

DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
VOL=/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-data/_data
PRIMARY=192.168.23.68
SLOT=pesowise_46_standby
PRES="${PRES:-${VOL}.preserved-ha-$(date -u +%Y%m%dT%H%M%SZ)}"

run_sudo() { echo "${SUDO_PASSWORD:?Set SUDO_PASSWORD}" | sudo -S "$@"; }

run_sudo docker stop "$DB" || true
if [[ -d "$VOL" ]]; then
  run_sudo mv "$VOL" "$PRES"
  run_sudo mkdir -p "$VOL"
fi

PP=$(docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1 || true)
PW="${PP:-}"
if [[ -z "$PW" && -f "$PRES/postgresql.auto.conf" ]]; then
  PW=$(run_sudo grep primary_conninfo "$PRES/postgresql.auto.conf" | sed -n 's/.*password=\([^ ]*\).*/\1/p' | tr -d '\r')
fi
[[ -n "$PW" ]] || { echo "ERROR: no replicator/password material" >&2; exit 1; }

run_sudo chown -R 105:106 "$VOL"
run_sudo env PGPASSWORD="$PW" docker run --rm --network host -e PGPASSWORD \
  -v "$VOL:/var/lib/postgresql/data" supabase/postgres:15.8.1.085 \
  pg_basebackup -h "$PRIMARY" -p 5432 -U replicator \
  -D /var/lib/postgresql/data -Fp -Xs -P -R -S "$SLOT"

if [[ -f "$PRES/postgresql.auto.conf" ]]; then
  run_sudo cp "$PRES/postgresql.auto.conf" "$VOL/postgresql.auto.conf"
  run_sudo sed -i "s/host=192.168.23.46/host=${PRIMARY}/g" "$VOL/postgresql.auto.conf"
  run_sudo sed -i "s/host=${PRIMARY//./\\.}/host=${PRIMARY}/g" "$VOL/postgresql.auto.conf" 2>/dev/null || true
fi
run_sudo touch "$VOL/standby.signal"
run_sudo bash -c "grep -v '^primary_slot_name' '$VOL/postgresql.auto.conf' > /tmp/pga46.conf"
run_sudo bash -c "echo \"primary_slot_name = '${SLOT}'\" >> /tmp/pga46.conf"
run_sudo cp /tmp/pga46.conf "$VOL/postgresql.auto.conf"
run_sudo chown -R 105:106 "$VOL"
run_sudo docker start "$DB"

echo "Rejoin basebackup complete. Verify pg_stat_wal_receiver on .46."
