#!/usr/bin/env bash
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
docker exec "$DB" psql -U supabase_admin -d postgres -x -c "SELECT slot_name, active, slot_type FROM pg_replication_slots;"
docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SHOW max_replication_slots;"
# Drop stale slot from reversed topology if inactive
docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_drop_replication_slot('pesowise_46_standby') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='pesowise_46_standby' AND NOT active);"
echo SLOTS_CLEANED
