#!/usr/bin/env bash
# Align replicator on .68 primary for .46 standby (PesoWise only).
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c "ALTER USER replicator WITH REPLICATION PASSWORD '$PP';"
HBA=/etc/postgresql/pg_hba.conf
run_sudo docker exec "$DB" bash -lc "grep -q '192.168.23.46' $HBA || printf '\nhost    replication     replicator      192.168.23.46/32        scram-sha-256\n' >> $HBA"
run_sudo docker exec "$DB" bash -lc "grep -q '10.0.2.1' $HBA || printf 'host    replication     replicator      10.0.2.1/32         scram-sha-256\n' >> $HBA"
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT pg_reload_conf();"
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_create_physical_replication_slot('pesowise_46_standby') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='pesowise_46_standby');"
echo REPLICATOR_OK
