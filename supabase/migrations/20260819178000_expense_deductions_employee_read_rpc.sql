-- DOC-099 — employee-safe read of their own expense_balance_deductions
-- rows, found missing during an independent repo scan (item 10: employee
-- balance history currently omits expense deductions entirely).
--
-- expense_balance_deductions has only an "Admins read org deductions" RLS
-- policy -- no employee-own-row access. This is a NEW additive, READ-ONLY
-- RPC mirroring the exact same security shape already proven in
-- get_my_balance_ledger_v1 / get_my_balance_transfer_history: SECURITY
-- DEFINER, auth.uid()-derived, active-membership required, row-scoped to
-- employee_user_id = caller inside the query body (no parameter exists to
-- request another user's rows). Does NOT touch review_approve_expense_v2,
-- expense_balance_deductions' own write path, or the UNIQUE(expense_id)
-- double-deduction guard -- purely additive read access.

CREATE OR REPLACE FUNCTION public.get_my_expense_deductions_v1(
  p_organization_id uuid,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
)
RETURNS TABLE (
  id             uuid,
  expense_id     uuid,
  amount         numeric,
  balance_before numeric,
  balance_after  numeric,
  created_at     timestamptz,
  total_count    bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Not an active member of this organization';
  END IF;

  RETURN QUERY
  SELECT
    ebd.id,
    ebd.expense_id,
    ebd.expense_amount,
    ebd.balance_before,
    ebd.balance_after,
    ebd.created_at,
    COUNT(*) OVER () AS total_count
  FROM public.expense_balance_deductions ebd
  WHERE ebd.organization_id = p_organization_id
    AND ebd.employee_user_id = v_uid
  ORDER BY ebd.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_expense_deductions_v1(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_expense_deductions_v1(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_expense_deductions_v1(uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_my_expense_deductions_v1(uuid, integer, integer) IS
  'DOC-099. Employee-safe paginated read of the caller''s OWN '
  'expense_balance_deductions rows -- mirrors get_my_balance_ledger_v1''s '
  'security shape exactly. Read-only; does not touch the deduction write '
  'path or review_approve_expense_v2.';

NOTIFY pgrst, 'reload schema';
