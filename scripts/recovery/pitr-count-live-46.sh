#!/usr/bin/env bash
BATCH="${BATCH:-PITR_WAL_BATCH_1790575046}"
docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH';"
