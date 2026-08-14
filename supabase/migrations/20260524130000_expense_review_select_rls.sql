-- Allow managers and hierarchy reviewers to SELECT expenses they must review.

DROP POLICY IF EXISTS "Engineers can view team reporting expenses" ON public.expenses;
CREATE POLICY "Engineers can view team reporting expenses"
  ON public.expenses FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND (
      expenses.assigned_engineer_id = auth.uid()
      OR (
        expenses.approval_tier = 'engineer'
        AND expenses.assigned_reviewer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = expenses.user_id
          AND p.organization_id = expenses.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "Hierarchy reviewers can view assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    expenses.assigned_reviewer_id = auth.uid()
    AND expenses.approval_tier IS NOT NULL
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
  );

COMMENT ON POLICY "Engineers can view team reporting expenses" ON public.expenses IS
  'Managers see expenses assigned to them, at engineer tier, or from direct reports (reporting_engineer_id).';

COMMENT ON POLICY "Hierarchy reviewers can view assigned expenses" ON public.expenses IS
  'Team leaders and executives can read expenses currently assigned to them at their tier.';
