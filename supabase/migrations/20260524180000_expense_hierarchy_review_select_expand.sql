-- Team leaders may be assigned via assigned_reviewer_id or assigned_engineer_id at their tier.

DROP POLICY IF EXISTS "Hierarchy reviewers can view assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    expenses.approval_tier IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND (
          (
            om.role = 'team_leader'
            AND expenses.approval_tier = 'team_leader'
            AND (
              expenses.assigned_reviewer_id = auth.uid()
              OR expenses.assigned_engineer_id = auth.uid()
            )
          )
          OR (
            om.role = 'executive'
            AND expenses.approval_tier = 'executive'
            AND (
              expenses.assigned_reviewer_id = auth.uid()
              OR expenses.assigned_engineer_id = auth.uid()
            )
          )
        )
    )
  );

COMMENT ON POLICY "Hierarchy reviewers can view assigned expenses" ON public.expenses IS
  'TL/executive can read expenses at their tier when assigned as reviewer or managing engineer.';
