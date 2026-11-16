#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
PRIMARY=192.168.23.68
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c "ALTER USER replicator WITH REPLICATION PASSWORD '$PP';"
run_sudo docker exec "$DB" bash -lc "grep -q 'PESOWISE_PITR_PERSISTED' /etc/postgresql/pg_hba.conf || cat >> /etc/postgresql/pg_hba.conf" <<'SNIP'

# PESOWISE_PITR_PERSISTED (local replication for pg_receivewal / basebackup)
local   replication     supabase_admin                          scram-sha-256
host    replication     replicator      192.168.23.46/32        scram-sha-256
SNIP
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT pg_reload_conf();"
echo PITR_HBA_OK
