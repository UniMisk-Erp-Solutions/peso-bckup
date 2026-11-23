#!/usr/bin/env bash
# Clean standby configuration on .46 and start streaming from .68 primary.
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
VOL=/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-data/_data
PRIMARY=192.168.23.68
SLOT=pesowise_46_standby

docker stop "$DB" || true

PP=$(docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
[[ -n "$PP" ]] || { echo "FAIL: no POSTGRES_PASSWORD"; exit 1; }

CONN="user=replicator password=${PP} channel_binding=prefer host=${PRIMARY} port=5432 sslmode=prefer sslcompression=0 sslsni=1 ssl_min_protocol_version=TLSv1.2 gssencmode=prefer krbsrvname=postgres target_session_attrs=any"

sudo tee "$VOL/postgresql.auto.conf" >/dev/null <<EOF
# PesoWise standby (manual HA rejoin)
hot_standby = on
primary_conninfo = '${CONN}'
primary_slot_name = '${SLOT}'
EOF

sudo touch "$VOL/standby.signal"
sudo rm -f "$VOL/recovery.done" "$VOL/standby.promote" 2>/dev/null || true

if ! sudo grep -q '^hot_standby = on' "$VOL/postgresql.conf" 2>/dev/null; then
  echo "hot_standby = on" | sudo tee -a "$VOL/postgresql.conf" >/dev/null
fi

sudo chown -R 105:106 "$VOL"
docker start "$DB"

for i in $(seq 1 45); do
  if docker exec "$DB" pg_isready -U postgres -q 2>/dev/null; then
    rec=$(docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo "")
    [[ "$rec" == "t" ]] && break
  fi
  sleep 2
done

echo -n "pg_is_in_recovery="
docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery();" || true
docker exec "$DB" psql -U postgres -d postgres -x -c "SELECT pid, status, slot_name, written_lsn FROM pg_stat_wal_receiver;" 2>/dev/null || docker logs "$DB" 2>&1 | tail -15
