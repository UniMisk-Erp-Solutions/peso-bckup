-- Fix: expense_batches SELECT policy was missing assigned_reviewer_id.
-- Team leaders and executives assigned as reviewers on any expense in a batch
-- could not read the batch row, causing a "match does not exist or no permission" error.

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
        AND ex.assigned_engineer_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.batch_id = expense_batches.id
        AND ex.assigned_reviewer_id = auth.uid()
    )
  );
