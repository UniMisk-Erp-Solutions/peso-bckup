-- ============================================================
-- FILE: 01_create_indexes_concurrently.sql
-- PURPOSE: Create missing performance indexes on public.expenses.
--
-- NOTE: CONCURRENTLY is removed here because Supabase SQL Editor
-- wraps statements in a transaction, which blocks CONCURRENTLY.
-- At ~5 MB the table is small enough that plain CREATE INDEX
-- completes in well under 1 second with no meaningful lock time.
--
-- IF NOT EXISTS makes every statement safe to re-run.
-- ============================================================

-- Index A: user_id + created_at DESC
-- Speeds up: "all expenses for a given user, newest first"
CREATE INDEX IF NOT EXISTS idx_expenses_user_created
  ON public.expenses (user_id, created_at DESC);

-- Index B: user_id + updated_at DESC
-- Speeds up: realtime-triggered refetches sorted by updated_at
CREATE INDEX IF NOT EXISTS idx_expenses_user_updated
  ON public.expenses (user_id, updated_at DESC);

-- Index C: batch_id + org + created_at (partial — only batched rows)
-- Speeds up: batch expansion queries
CREATE INDEX IF NOT EXISTS idx_expenses_batch_org_created
  ON public.expenses (batch_id, organization_id, created_at DESC)
  WHERE batch_id IS NOT NULL;

-- Verify all three exist
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename  = 'expenses'
  AND indexname IN (
    'idx_expenses_user_created',
    'idx_expenses_user_updated',
    'idx_expenses_batch_org_created'
  );
