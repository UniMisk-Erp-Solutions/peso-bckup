#!/usr/bin/env bash
set -euo pipefail
VOL=/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-data/_data
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
docker stop "$DB" || true
PP=$(docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
CONN="user=replicator password=${PP} channel_binding=prefer host=192.168.23.68 port=5432 sslmode=prefer sslcompression=0 sslsni=1 ssl_min_protocol_version=TLSv1.2 gssencmode=prefer krbsrvname=postgres target_session_attrs=any"
sudo grep -v '^primary_conninfo' "$VOL/postgresql.auto.conf" | sudo tee "$VOL/postgresql.auto.conf.new" >/dev/null
echo "primary_conninfo = '${CONN}'" | sudo tee -a "$VOL/postgresql.auto.conf.new" >/dev/null
echo "primary_slot_name = 'pesowise_46_standby'" | sudo tee -a "$VOL/postgresql.auto.conf.new" >/dev/null
sudo mv "$VOL/postgresql.auto.conf.new" "$VOL/postgresql.auto.conf"
sudo touch "$VOL/standby.signal"
sudo sed -i '/^hot_standby/d' "$VOL/postgresql.conf" 2>/dev/null || true
echo "hot_standby = on" | sudo tee -a "$VOL/postgresql.conf" >/dev/null
sudo chown -R 105:106 "$VOL"
docker start "$DB"
for i in $(seq 1 30); do
  docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery();"
docker exec "$DB" psql -U postgres -d postgres -x -c "SELECT status, slot_name FROM pg_stat_wal_receiver;"
