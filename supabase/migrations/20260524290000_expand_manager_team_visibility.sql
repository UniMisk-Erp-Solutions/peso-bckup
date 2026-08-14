-- Managers who are team.manager_user_id must see all team members' in-review expenses,
-- not only profiles.reporting_engineer_id direct reports.

CREATE OR REPLACE FUNCTION public.list_manager_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review',
      'level_1_verified',
      'level_2_verified'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR (
        e.approval_tier = 'engineer'
        AND (
          e.assigned_reviewer_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
          AND t.organization_id = tm.organization_id
        WHERE tm.user_id = e.user_id
          AND tm.organization_id = e.organization_id
          AND t.manager_user_id = auth.uid()
      )
    );
$$;

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
      OR expenses.assigned_reviewer_id = auth.uid()
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
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
          AND t.organization_id = tm.organization_id
        WHERE tm.user_id = expenses.user_id
          AND tm.organization_id = expenses.organization_id
          AND t.manager_user_id = auth.uid()
      )
    )
  );

COMMENT ON POLICY "Engineers can view team reporting expenses" ON public.expenses IS
  'Managers see assigned expenses, engineer-tier queue, direct reports, and any team they manage.';
