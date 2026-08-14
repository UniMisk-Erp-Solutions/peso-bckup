-- Run this entire file in Supabase SQL Editor (Dashboard → SQL → New query).
-- Keeps manager-approved expenses visible on Assigned Expenses.

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
    AND public.manager_expense_visible_to_user(e, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      (
        e.status NOT IN ('verified', 'approved', 'rejected')
        AND (
          public.expense_ready_for_manager_review(e)
          OR public.expense_executive_handoff_in_audit(e)
        )
      )
      OR (
        e.status IN ('verified', 'approved', 'rejected')
        AND (
          e.assigned_engineer_id = auth.uid()
          OR e.assigned_reviewer_id = auth.uid()
          OR EXISTS (
            SELECT 1
            FROM public.audit_logs al
            WHERE al.expense_id = e.id
              AND al.organization_id = p_organization_id
              AND al.user_id = auth.uid()
              AND al.action IN ('expense_verified', 'expense_approved', 'tier_advanced')
          )
        )
      )
    )
  ORDER BY e.updated_at DESC;
$$;

REVOKE ALL ON FUNCTION public.list_manager_pending_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_pending_expenses(uuid) TO authenticated;
