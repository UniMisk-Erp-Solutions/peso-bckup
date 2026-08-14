-- Team leaders / executives verify by advancing tier (reassigns reviewer) or rejecting (clears tier).
-- The old WITH CHECK required assigned_reviewer_id = auth.uid() on the NEW row, which blocked both flows.

DROP POLICY IF EXISTS "Hierarchy reviewers can update assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = assigned_reviewer_id
    AND approval_tier IS NOT NULL
    AND status IN ('submitted', 'edited')
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND (
          (om.role = 'team_leader' AND expenses.approval_tier = 'team_leader')
          OR (om.role = 'executive' AND expenses.approval_tier = 'executive')
        )
    )
  )
  WITH CHECK (
    status IN ('submitted', 'edited', 'rejected')
    AND status <> 'approved'
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND om.role IN ('team_leader', 'executive')
    )
  );

COMMENT ON POLICY "Hierarchy reviewers can update assigned expenses" ON public.expenses IS
  'TL/executive may advance tier (new assignee) or reject (clears tier) after passing USING on the prior row.';
