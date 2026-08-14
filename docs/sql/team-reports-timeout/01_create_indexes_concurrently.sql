-- ============================================================
-- FILE: 01_create_indexes_concurrently.sql
-- PURPOSE: Create the missing expenses indexes safely using
--          CONCURRENTLY — does not lock the table for writes.
-- SAFE: Does not modify data. IF NOT EXISTS prevents errors
--       if the index already exists.
--
-- ██████  IMPORTANT: RUN STATEMENTS ONE AT A TIME  ██████
--
-- Do NOT paste all four statements together in Supabase SQL Editor.
-- CONCURRENTLY cannot run inside a transaction block.
-- If SQL Editor wraps your query in BEGIN/COMMIT automatically,
-- you will get this error:
--   ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
--
-- In that case, use file: 01b_create_indexes_non_concurrent_fallback.sql
--
-- RECOMMENDED RUN ORDER:
--   1. Run Statement 1 first. Wait for "Success. No rows returned."
--   2. Run Statement 2.
--   3. Run Statement 3.
--   4. Run Statement 4.
--   5. Then run 02_verify_indexes_and_query_plan.sql to confirm.
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- STATEMENT 1 (run first — this is the primary timeout fix)
-- ──────────────────────────────────────────────────────────
-- Covers: WHERE organization_id = ? AND status IN (...)
--         ORDER BY created_at DESC
-- This is exactly the query fired by Team Reports Claim Verification List.
-- Without this index: full table scan + memory sort → 8s timeout (57014).
-- With this index: index scan → <100ms.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_org_status_created
  ON public.expenses(organization_id, status, created_at DESC);


-- ──────────────────────────────────────────────────────────
-- STATEMENT 2
-- ──────────────────────────────────────────────────────────
-- Covers: WHERE user_id = ? ORDER BY updated_at DESC
-- Used by: employee expense list pagination (Expenses.tsx)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_user_updated
  ON public.expenses(user_id, updated_at DESC);


-- ──────────────────────────────────────────────────────────
-- STATEMENT 3
-- ──────────────────────────────────────────────────────────
-- Covers: WHERE batch_id = ? AND organization_id = ? ORDER BY created_at ASC
-- Used by: BatchExpenseReviewPanel, ExpenseForm batch fetches

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_batch_org_created
  ON public.expenses(batch_id, organization_id, created_at ASC)
  WHERE batch_id IS NOT NULL;


-- ──────────────────────────────────────────────────────────
-- STATEMENT 4
-- ──────────────────────────────────────────────────────────
-- Covers: WHERE user_id = ? AND created_at BETWEEN ? AND ?
-- Used by: analytics date-range queries per employee

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_user_created
  ON public.expenses(user_id, created_at DESC);
