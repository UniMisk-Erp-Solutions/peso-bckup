#!/usr/bin/env bash
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
docker exec "$DB" psql -U supabase_admin -tAc "SELECT pg_walfile_name(pg_current_wal_lsn());"
docker exec "$DB" ls /var/lib/postgresql/data/pg_wal | tail -12
