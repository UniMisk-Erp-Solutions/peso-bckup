#!/usr/bin/env bash
# Align .46 primary for .68 read replica + PITR slot (PesoWise only).
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
HBA=/etc/postgresql/pg_hba.conf
PP=$(docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)

docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c "ALTER USER replicator WITH REPLICATION PASSWORD '$PP';"

docker exec "$DB" bash -lc "grep -q '192.168.23.68' $HBA || printf '\nhost    replication     replicator      192.168.23.68/32        scram-sha-256\n' >> $HBA"
GW=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' "$DB" | head -1)
if [[ -n "$GW" ]]; then
  docker exec "$DB" bash -lc "grep -q '$GW' $HBA || printf 'host    replication     replicator      ${GW}/32         scram-sha-256\n' >> $HBA"
  docker exec "$DB" bash -lc "grep -q 'supabase_admin.*${GW}' $HBA || printf 'host    replication     supabase_admin  ${GW}/32         scram-sha-256\n' >> $HBA"
fi
docker exec "$DB" bash -lc "grep -q 'supabase_admin.*192.168.23.68' $HBA || printf 'host    replication     supabase_admin  192.168.23.68/32     scram-sha-256\n' >> $HBA"

docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT pg_reload_conf();"

docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_create_physical_replication_slot('pesowise_68_standby') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='pesowise_68_standby');"
docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_create_physical_replication_slot('pesowise_pitr') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='pesowise_pitr');"

echo PREPARE_46_OK
