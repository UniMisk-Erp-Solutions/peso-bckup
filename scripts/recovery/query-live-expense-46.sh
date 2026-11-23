#!/usr/bin/env bash
docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE title LIKE 'PITR_WAL_DEMO_%';"
