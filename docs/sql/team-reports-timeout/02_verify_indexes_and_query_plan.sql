-- ============================================================
-- FILE: 02_verify_indexes_and_query_plan.sql
-- PURPOSE: Confirm the new indexes exist and the failing
--          Team Reports query now uses them.
-- SAFE: Read-only. No data changes.
-- RUN AFTER: 01_create_indexes_concurrently.sql (or 01b)
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- PART 1: Check whether the four new indexes exist
-- ──────────────────────────────────────────────────────────
-- Expected: 4 rows returned, one per index name.
-- If fewer than 4 rows: re-run the missing index from 01b.

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'expenses'
  AND indexname IN (
    'idx_expenses_org_status_created',
    'idx_expenses_user_updated',
    'idx_expenses_batch_org_created',
    'idx_expenses_user_created'
  )
ORDER BY indexname;

-- Expected result (4 rows):
-- idx_expenses_batch_org_created  | CREATE INDEX ... ON expenses(batch_id, organization_id, created_at) WHERE batch_id IS NOT NULL
-- idx_expenses_org_status_created | CREATE INDEX ... ON expenses(organization_id, status, created_at DESC)
-- idx_expenses_user_created       | CREATE INDEX ... ON expenses(user_id, created_at DESC)
-- idx_expenses_user_updated       | CREATE INDEX ... ON expenses(user_id, updated_at DESC)


-- ──────────────────────────────────────────────────────────
-- PART 2: EXPLAIN ANALYZE the failing query
-- ──────────────────────────────────────────────────────────
-- This runs the ACTUAL query (reads data) and shows the
-- execution plan with real timing.
--
-- GOOD signs in the output:
--   "Index Scan using idx_expenses_org_status_created on expenses"
--   OR "Bitmap Index Scan on idx_expenses_org_status_created"
--   Execution Time: under 300 ms
--
-- BAD signs (index not used or not yet created):
--   "Seq Scan on expenses"  followed by  "Sort"
--   Execution Time: over 1000 ms
--   Planning Time + Execution Time combined over 8000 ms → timeout

EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id,
  user_id,
  title,
  total_amount,
  status,
  created_at,
  trip_start,
  trip_end,
  category,
  purpose,
  destination,
  transaction_number,
  batch_id
FROM public.expenses
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND status IN ('verified', 'level_1_verified', 'level_2_verified')
ORDER BY created_at DESC
LIMIT 100;

-- ──────────────────────────────────────────────────────────
-- HOW TO INTERPRET THE EXPLAIN OUTPUT
-- ──────────────────────────────────────────────────────────
--
-- Index working correctly (example):
--   Index Scan using idx_expenses_org_status_created on expenses
--     Index Cond: ((organization_id = '...') AND (status = ANY ('{...}'::text[])))
--   Planning Time: 0.5 ms
--   Execution Time: 12.3 ms      ← fast
--
-- Index NOT used (broken, need to recreate):
--   Seq Scan on expenses
--     Filter: ((organization_id = '...') AND (status = ANY (...)))
--   Sort
--     Sort Key: created_at DESC
--   Planning Time: 0.8 ms
--   Execution Time: 9241.2 ms    ← slow, will timeout in prod
