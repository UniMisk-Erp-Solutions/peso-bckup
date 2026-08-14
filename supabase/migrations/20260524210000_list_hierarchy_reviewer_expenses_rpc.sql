-- List expenses assigned to the current team leader / executive (bypasses SELECT RLS gaps).

CREATE OR REPLACE FUNCTION public.list_hierarchy_reviewer_expenses(p_organization_id uuid)
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
      'under_review'
    )
    AND (
      e.assigned_reviewer_id = auth.uid()
      OR e.assigned_engineer_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role IN ('team_leader', 'executive')
    );
$$;

REVOKE ALL ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) IS
  'Returns expenses awaiting action by the signed-in team leader or executive (matches notification routing).';

-- Backfill rows that notified via assigned_engineer_id only (legacy submit path).
UPDATE public.expenses e
SET
  approval_tier = 'team_leader',
  assigned_reviewer_id = e.assigned_engineer_id
WHERE e.approval_tier IS NULL
  AND e.assigned_reviewer_id IS NULL
  AND e.status IN ('submitted', 'edited', 'under_review')
  AND e.assigned_engineer_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = e.assigned_engineer_id
      AND om.organization_id = e.organization_id
      AND om.role = 'team_leader'
      AND om.is_active = true
  );

UPDATE public.expenses e
SET
  approval_tier = 'executive',
  assigned_reviewer_id = e.assigned_engineer_id
WHERE e.approval_tier IS NULL
  AND e.assigned_reviewer_id IS NULL
  AND e.status IN ('submitted', 'edited', 'under_review')
  AND e.assigned_engineer_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = e.assigned_engineer_id
      AND om.organization_id = e.organization_id
      AND om.role = 'executive'
      AND om.is_active = true
  );
