-- 010626_1430_manager_level2_queue_visibility.sql
-- Manager (engineer role) could not see level_2_verified expenses when assignment fields
-- still pointed at TL/executive instead of teams.manager_user_id.

CREATE OR REPLACE FUNCTION public.manager_expense_visible_to_user(
  e public.expenses,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_user_id IS NOT NULL
    AND (
      e.assigned_engineer_id = p_user_id
      OR e.assigned_reviewer_id = p_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = p_user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles emp
        JOIN public.profiles sup
          ON sup.user_id = emp.reporting_engineer_id
         AND sup.organization_id = emp.organization_id
        WHERE emp.user_id = e.user_id
          AND emp.organization_id = e.organization_id
          AND (
            emp.reporting_engineer_id = p_user_id
            OR sup.reporting_engineer_id = p_user_id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
         AND t.organization_id = tm.organization_id
        WHERE tm.user_id = e.user_id
          AND tm.organization_id = e.organization_id
          AND t.manager_user_id = p_user_id
      )
    );
$$;

-- Align assignments on existing Level 2 rows so manager queue + RLS stay consistent.
UPDATE public.expenses e
SET
  approval_tier = 'engineer',
  assigned_engineer_id = COALESCE(e.assigned_engineer_id, t.manager_user_id),
  assigned_reviewer_id = COALESCE(e.assigned_reviewer_id, t.manager_user_id),
  updated_at = now()
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
 AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status = 'level_2_verified'::public.expense_status
  AND e.status NOT IN ('verified', 'approved', 'rejected')
  AND (
    e.approval_tier IS DISTINCT FROM 'engineer'
    OR e.assigned_engineer_id IS DISTINCT FROM t.manager_user_id
    OR e.assigned_reviewer_id IS DISTINCT FROM t.manager_user_id
  );

DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);

CREATE OR REPLACE FUNCTION public.list_manager_pending_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND (
      public.expense_ready_for_manager_review(e)
      OR public.expense_executive_handoff_in_audit(e)
    )
    AND public.manager_expense_visible_to_user(e, auth.uid())
    AND e.status NOT IN ('verified', 'approved', 'rejected')
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
  ORDER BY e.updated_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.list_manager_pending_expenses(uuid) TO authenticated;
