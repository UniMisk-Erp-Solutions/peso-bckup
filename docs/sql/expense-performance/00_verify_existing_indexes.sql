-- ============================================================
-- FILE: 00_verify_existing_indexes.sql
-- PURPOSE: Check which indexes currently exist on public.expenses
--          and whether any are still being built (CONCURRENTLY).
--
-- Run this first before creating new indexes.
-- ============================================================

-- 1. List all indexes on expenses table
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'expenses'
ORDER BY indexname;


-- 2. Check if any index build is still in progress
-- (pg_stat_progress_create_index has no index_name column; join pg_class to get it)
SELECT
  p.phase,
  p.blocks_done,
  p.blocks_total,
  ROUND(p.blocks_done::numeric / NULLIF(p.blocks_total, 0) * 100, 1) AS pct_done,
  c.relname AS index_name
FROM pg_stat_progress_create_index p
LEFT JOIN pg_class c ON c.oid = p.index_relid
WHERE p.relid = 'public.expenses'::regclass;
-- No rows = no index build in progress.


-- 3. Check table size (context for how long index builds take)
SELECT
  pg_size_pretty(pg_total_relation_size('public.expenses')) AS expenses_total_size,
  pg_size_pretty(pg_relation_size('public.expenses'))       AS expenses_heap_size,
  (SELECT reltuples::bigint FROM pg_class WHERE relname = 'expenses') AS estimated_row_count;
