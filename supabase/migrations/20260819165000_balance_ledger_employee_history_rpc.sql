-- DOC-099 — employee-visible unified balance ledger history.
--
-- The existing get_my_balance_transfer_history (DOC-?) is explicitly and
-- deliberately NOT a full ledger (Documentations MD/balance-system-and-
-- import-audit.md §3.6): it only shows received cash_transfer_history rows,
-- never expense deductions, opening balances, allocations, adjustments, or
-- reversals. It is left untouched -- extending it in place would conflict
-- with its own stated scope. This is a new, parallel, ADDITIVE RPC over
-- balance_ledger, which every new financial mutation in this feature writes
-- to (and which will absorb expense_deduction entries in a later, separate
-- integration phase per the owner's explicit "do not rewrite
-- review_approve_expense_v2 today" instruction).
--
-- Same security shape as get_my_balance_transfer_history: SECURITY DEFINER,
-- auth.uid()-derived caller identity (no p_user_id parameter exists), active
-- membership required, row-scoped to the caller's own entries only, bounded
-- server-side pagination.

CREATE OR REPLACE FUNCTION public.get_my_balance_ledger_v1(
  p_organization_id uuid,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
)
RETURNS TABLE (
  id             uuid,
  entry_type     text,
  amount_delta   numeric,
  balance_after  numeric,
  effective_at   timestamptz,
  note           text,
  source_type    text,
  actor_name     text,
  total_count    bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_limit  integer;
  v_offset integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'An organization context is required.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Caller has no active membership in this organization.';
  END IF;

  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  RETURN QUERY
  SELECT
    bl.id,
    bl.entry_type,
    bl.amount_delta,
    bl.balance_after,
    bl.effective_at,
    bl.note,
    bl.source_type,
    actor.name AS actor_name,
    COUNT(*) OVER () AS total_count
  FROM public.balance_ledger bl
  LEFT JOIN public.profiles actor
         ON actor.user_id = bl.actor_user_id AND actor.organization_id = bl.organization_id
  WHERE bl.organization_id = p_organization_id
    AND bl.user_id = v_uid
  ORDER BY bl.effective_at DESC, bl.id DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_balance_ledger_v1(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_balance_ledger_v1(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_balance_ledger_v1(uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_my_balance_ledger_v1(uuid, integer, integer) IS
  'DOC-099. Employee-safe, paginated read of the caller''s OWN balance_ledger '
  'entries (opening/allocation/adjustment/transfer/reversal). Row-scoped by '
  'auth.uid() inside the function body, not by table RLS (SECURITY DEFINER '
  'bypasses it) -- there is no parameter through which a caller can request '
  'another user''s entries. expense_deduction entries are not yet written to '
  'balance_ledger (separate integration phase); until then this view is '
  'additive to, not a replacement for, get_my_balance_transfer_history.';

-- Admin-scoped org-wide ledger read, for the Balances page / import result
-- drill-down (not employee-facing).
CREATE OR REPLACE FUNCTION public.get_org_balance_ledger_v1(
  p_organization_id uuid,
  p_user_id         uuid DEFAULT NULL,
  p_limit           integer DEFAULT 50,
  p_offset          integer DEFAULT 0
)
RETURNS TABLE (
  id             uuid,
  user_id        uuid,
  employee_id    text,
  employee_name  text,
  entry_type     text,
  amount_delta   numeric,
  balance_before numeric,
  balance_after  numeric,
  effective_at   timestamptz,
  note           text,
  source_type    text,
  source_id      uuid,
  actor_name     text,
  total_count    bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_limit  integer;
  v_offset integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id
      AND om.role = 'admin' AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Admin role required in this organization.';
  END IF;

  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  RETURN QUERY
  SELECT
    bl.id, bl.user_id, p.employee_id, p.name,
    bl.entry_type, bl.amount_delta, bl.balance_before, bl.balance_after,
    bl.effective_at, bl.note, bl.source_type, bl.source_id,
    actor.name AS actor_name,
    COUNT(*) OVER () AS total_count
  FROM public.balance_ledger bl
  LEFT JOIN public.profiles p ON p.user_id = bl.user_id AND p.organization_id = bl.organization_id
  LEFT JOIN public.profiles actor ON actor.user_id = bl.actor_user_id AND actor.organization_id = bl.organization_id
  WHERE bl.organization_id = p_organization_id
    AND (p_user_id IS NULL OR bl.user_id = p_user_id)
  ORDER BY bl.effective_at DESC, bl.id DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_org_balance_ledger_v1(uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_balance_ledger_v1(uuid, uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_org_balance_ledger_v1(uuid, uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_org_balance_ledger_v1(uuid, uuid, integer, integer) IS
  'DOC-099. Admin-only, organization-scoped, paginated ledger read -- for the '
  'Balances page ledger drill-down and import-result "View ledger" link. '
  'Optionally filtered to one employee via p_user_id.';

NOTIFY pgrst, 'reload schema';
