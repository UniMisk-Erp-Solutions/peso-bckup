-- Keep TL/executive review history visible after verify (assignment moves to next tier).

CREATE OR REPLACE FUNCTION public.list_hierarchy_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT e.*
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
        AND om.role IN ('team_leader', 'executive')
    )
    AND (
      e.assigned_reviewer_id = auth.uid()
      OR e.assigned_engineer_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.audit_logs al
        WHERE al.expense_id = e.id
          AND al.organization_id = p_organization_id
          AND al.user_id = auth.uid()
          AND al.action IN (
            'expense_verified',
            'expense_approved',
            'tier_advanced',
            'expense_rejected'
          )
      )
    )
  ORDER BY e.updated_at DESC;
$$;

REVOKE ALL ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) IS
  'TL/executive review queue plus expenses this reviewer verified, advanced, approved, or rejected.';
