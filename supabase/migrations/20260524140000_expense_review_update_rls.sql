-- Allow engineers to UPDATE expenses they can already SELECT for review (verify / reject / approve).

DROP POLICY IF EXISTS "Engineers can update assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND status IN ('submitted', 'edited', 'verified')
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
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND status IN ('submitted', 'edited', 'verified', 'rejected', 'approved')
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

COMMENT ON POLICY "Engineers can update assigned expenses" ON public.expenses IS
  'Managers can verify/reject/approve expenses assigned to them, at engineer tier, or from direct reports (reporting_engineer_id).';
