-- Allow hierarchy reviewers (team_leader / executive) to view expense batches.
-- The original policy only covered the submitter, admins, and assigned engineers.
-- Team leaders and executives who are assigned as assigned_reviewer_id on any
-- expense inside a batch must also be able to read the batch header.

DROP POLICY IF EXISTS "Users can view own expense batches" ON public.expense_batches;

CREATE POLICY "Users can view own expense batches"
  ON public.expense_batches FOR SELECT
  USING (
    -- submitter
    user_id = auth.uid()
    -- org admin
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_batches.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
    -- engineer assigned to any line in the batch
    OR EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.batch_id = expense_batches.id
        AND ex.assigned_engineer_id = auth.uid()
    )
    -- hierarchy reviewer (team_leader / executive) assigned to any line in the batch
    OR EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.batch_id = expense_batches.id
        AND ex.assigned_reviewer_id = auth.uid()
    )
  );
