-- ============================================================
-- FILE: 01b_create_indexes_non_concurrent_fallback.sql
-- PURPOSE: Fallback index creation WITHOUT CONCURRENTLY.
--
-- USE THIS IF 01_create_indexes_concurrently.sql fails with:
--   ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
--
-- DIFFERENCE FROM 01_CONCURRENTLY:
--   - This version briefly locks the expenses table for WRITES
--     during the index build.
--   - Reads (SELECT) are not blocked.
--   - Safe to use during low-traffic periods.
--   - All statements are IF NOT EXISTS — safe to re-run even if
--     some indexes already exist.
--
-- RECOMMENDED RUN ORDER:
--   You can paste all 4 statements at once, or run one at a time.
--   Then run 02_verify_indexes_and_query_plan.sql to confirm.
-- ============================================================


-- PRIMARY FIX — run this first, it unblocks Team Reports
CREATE INDEX IF NOT EXISTS idx_expenses_org_status_created
  ON public.expenses(organization_id, status, created_at DESC);

-- Employee expense list pagination
CREATE INDEX IF NOT EXISTS idx_expenses_user_updated
  ON public.expenses(user_id, updated_at DESC);

-- Batch row fetches
CREATE INDEX IF NOT EXISTS idx_expenses_batch_org_created
  ON public.expenses(batch_id, organization_id, created_at ASC)
  WHERE batch_id IS NOT NULL;

-- Analytics date-range queries
CREATE INDEX IF NOT EXISTS idx_expenses_user_created
  ON public.expenses(user_id, created_at DESC);
