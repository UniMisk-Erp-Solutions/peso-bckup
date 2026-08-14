-- ============================================================
-- Fix 1: expense_batches SELECT RLS — add assigned_reviewer_id arm
-- ============================================================
-- The original policy (20260513160000) predates hierarchy roles (team_leader / executive).
-- Assigned reviewers were added to expenses RLS on 20260524 but expense_batches was missed.
-- This blocks managers from opening batch review pages even when assigned as reviewer.

DROP POLICY IF EXISTS "Users can view own expense batches" ON public.expense_batches;

CREATE POLICY "Users can view own expense batches"
  ON public.expense_batches FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_batches.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.batch_id = expense_batches.id
        AND ex.organization_id = expense_batches.organization_id
        AND ex.assigned_engineer_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.batch_id = expense_batches.id
        AND ex.organization_id = expense_batches.organization_id
        AND ex.assigned_reviewer_id = auth.uid()
    )
  );

-- Supporting indexes for the new EXISTS arms
CREATE INDEX IF NOT EXISTS idx_expenses_batch_assigned_engineer
  ON public.expenses (batch_id, assigned_engineer_id)
  WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_batch_assigned_reviewer
  ON public.expenses (batch_id, assigned_reviewer_id)
  WHERE batch_id IS NOT NULL AND assigned_reviewer_id IS NOT NULL;

-- ============================================================
-- Fix 2: attachments.storage_path — add column if absent
-- ============================================================
-- Stores the bucket-relative path of the file in the receipts bucket
-- (e.g. temp/userId/file.jpg or expenseId/file.jpg).
-- NOTE: no unique index — existing data has duplicate storage_path values
-- from the previous bare-filename storage convention.

ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

COMMENT ON COLUMN public.attachments.storage_path IS
  'Bucket-relative path of the file in the receipts bucket (e.g. temp/userId/filename.jpg or expenseId/filename.jpg). Populated on insert; null for rows written before this migration.';
