-- Dashboard aggregates in one DB round-trip (avoids loading every expense row in the browser).

CREATE OR REPLACE FUNCTION public.get_dashboard_expense_summary(
  p_organization_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total_amount', COALESCE(SUM(e.total_amount), 0),
    'pending_amount', COALESCE(
      SUM(e.total_amount) FILTER (WHERE e.status IN ('submitted', 'verified')),
      0
    ),
    'approved_amount', COALESCE(
      SUM(e.total_amount) FILTER (WHERE e.status = 'approved'),
      0
    ),
    'expense_count', COUNT(*)::bigint,
    'pending_approvals', COUNT(*) FILTER (
      WHERE e.status = 'verified'
        OR (e.status = 'submitted' AND e.assigned_engineer_id IS NULL)
    )::bigint,
    'pending_approvals_amount', COALESCE(
      SUM(e.total_amount) FILTER (
        WHERE e.status = 'verified'
          OR (e.status = 'submitted' AND e.assigned_engineer_id IS NULL)
      ),
      0
    )
  )
  FROM public.expenses e
  WHERE (p_organization_id IS NULL OR e.organization_id = p_organization_id)
    AND (p_user_id IS NULL OR e.user_id = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.get_org_role_balance_totals(p_organization_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'employee', COALESCE(SUM(p.balance) FILTER (WHERE m.role = 'employee'), 0),
    'engineer', COALESCE(SUM(p.balance) FILTER (WHERE m.role = 'engineer'), 0),
    'cashier', COALESCE(SUM(p.balance) FILTER (WHERE m.role = 'cashier'), 0)
  )
  FROM public.profiles p
  INNER JOIN public.organization_memberships m
    ON m.user_id = p.user_id
   AND m.organization_id = p_organization_id
   AND m.is_active = true
  WHERE p.organization_id = p_organization_id;
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_expense_summary(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_expense_summary(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_org_role_balance_totals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_org_role_balance_totals(uuid) TO authenticated;
