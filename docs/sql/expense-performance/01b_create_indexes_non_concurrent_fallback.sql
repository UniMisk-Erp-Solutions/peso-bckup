-- ============================================================
-- FILE: 01b_create_indexes_non_concurrent_fallback.sql
-- PURPOSE: Identical to 01 — kept for reference.
--          Both files now use plain CREATE INDEX (no CONCURRENTLY).
--          Run either one; IF NOT EXISTS makes re-running safe.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_expenses_user_created
  ON public.expenses (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_user_updated
  ON public.expenses (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_batch_org_created
  ON public.expenses (batch_id, organization_id, created_at DESC)
  WHERE batch_id IS NOT NULL;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename  = 'expenses'
  AND indexname IN (
    'idx_expenses_user_created',
    'idx_expenses_user_updated',
    'idx_expenses_batch_org_created'
  );
