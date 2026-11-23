#!/usr/bin/env bash
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
HBA=/etc/postgresql/pg_hba.conf
docker exec "$DB" bash -lc "grep -q 'local.*replication.*postgres' $HBA || echo 'local   replication     postgres                                trust' >> $HBA"
docker exec "$DB" psql -U supabase_admin -tAc "SELECT pg_reload_conf();"
bash /tmp/ha/pitr-base-backup-46-pack.sh
