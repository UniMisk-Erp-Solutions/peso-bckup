#!/usr/bin/env bash
set -euo pipefail
VOL=/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-data/_data
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
sudo rm -rf "${VOL:?}"/*
sudo tar -xf /tmp/rejoin-46.tar -C "$VOL"
sudo touch "$VOL/standby.signal"
if [[ -f "$VOL/postgresql.auto.conf" ]]; then
  sudo grep -v primary_slot_name "$VOL/postgresql.auto.conf" | sudo tee /tmp/pga46.conf >/dev/null
  echo "primary_slot_name = 'pesowise_46_standby'" | sudo tee -a /tmp/pga46.conf >/dev/null
  sudo cp /tmp/pga46.conf "$VOL/postgresql.auto.conf"
  sudo sed -i 's/host=192.168.23.46/host=192.168.23.68/g' "$VOL/postgresql.auto.conf" || true
fi
sudo chown -R 105:106 "$VOL"
sudo docker start "$DB"
sleep 12
docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery();"
docker exec "$DB" psql -U postgres -d postgres -x -c "SELECT status, slot_name FROM pg_stat_wal_receiver;"
