-- ============================================================
-- FILE: 02_explain_current_expense_queries.sql
-- PURPOSE: EXPLAIN ANALYZE the hot expense query patterns to
--          confirm index usage. Uses real IDs pulled from the DB
--          so no manual substitution is needed.
-- ============================================================

-- ── Pick a real user_id and org_id to test with ─────────────
-- (uses the user with the most expenses so the plan is realistic)
DO $$ BEGIN RAISE NOTICE 'Using auto-selected user/org from expenses table'; END $$;


-- Query 1: User expense list (EngineerReview / Expenses page pattern)
-- Expected: Index Scan on idx_expenses_user_created
EXPLAIN ANALYZE
SELECT id, user_id, title, total_amount, status, created_at,
       trip_start, trip_end, category, purpose, destination,
       transaction_number, batch_id
FROM public.expenses
WHERE user_id = (
  SELECT user_id FROM public.expenses
  GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1
)
ORDER BY created_at DESC
LIMIT 200;


-- Query 2: Org-wide expense list with status filter (AdminPanel pattern)
-- Expected: Bitmap Index Scan on idx_expenses_org_status_created
EXPLAIN ANALYZE
SELECT id, user_id, title, total_amount, status, created_at,
       trip_start, trip_end, category, purpose, destination,
       transaction_number, batch_id
FROM public.expenses
WHERE organization_id = (
  SELECT organization_id FROM public.expenses LIMIT 1
)
  AND status IN ('submitted','verified','level_1_verified','level_2_verified','approved','rejected')
ORDER BY created_at DESC
LIMIT 500;


-- Query 3: Batch expansion (BatchExpenseContextCard pattern)
-- Expected: Index Scan on idx_expenses_batch_org_created
EXPLAIN ANALYZE
SELECT id, user_id, title, total_amount, status, created_at
FROM public.expenses
WHERE batch_id = (
  SELECT batch_id FROM public.expenses WHERE batch_id IS NOT NULL LIMIT 1
)
  AND organization_id = (
  SELECT organization_id FROM public.expenses WHERE batch_id IS NOT NULL LIMIT 1
)
ORDER BY created_at DESC;


-- Query 4: Manager review — assigned_engineer_id filter
EXPLAIN ANALYZE
SELECT id, user_id, title, total_amount, status, created_at, assigned_engineer_id
FROM public.expenses
WHERE organization_id = (
  SELECT organization_id FROM public.expenses LIMIT 1
)
  AND assigned_engineer_id = (
  SELECT assigned_engineer_id FROM public.expenses
  WHERE assigned_engineer_id IS NOT NULL LIMIT 1
)
ORDER BY created_at DESC
LIMIT 200;
