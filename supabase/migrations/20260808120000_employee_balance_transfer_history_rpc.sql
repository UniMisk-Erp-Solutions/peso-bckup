-- DOC-087 — Employee Balance History (feature key: employee_transfer_history)
--
-- Employees currently have NO SELECT path on public.cash_transfer_history: the
-- table policies admit admins (org-wide) and cashiers (rows they sent/received)
-- only, plus accountant cashiers via is_accountant_cashier(). That is deliberate
-- and is NOT widened here — the admin/cashier surface keeps exactly the columns
-- and scope it has today.
--
-- Instead this migration adds a purpose-built, employee-safe read RPC. It is the
-- server-side half of the feature gate: entering the route by hand or invoking
-- the RPC directly still fails closed when employee_transfer_history is off for
-- the organization.
--
-- Deliberately NOT returned to employees:
--   recipient_id, transferrer_id, transferrer_role, recipient_role,
--   source_bank_account_id, source_account_number_masked_snapshot,
--   source_account_holder_snapshot, notes (may hold internal/admin audit text),
--   transferred_at_original / _edited_at / _edited_by / date_edited,
--   emails, employee IDs, membership metadata, organization-wide aggregates.

CREATE OR REPLACE FUNCTION public.get_my_balance_transfer_history(
  p_organization_id uuid,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
)
RETURNS TABLE (
  id               uuid,
  amount           numeric,
  transferred_at   timestamptz,
  payment_mode     text,
  transfer_type    text,
  credited_by_name text,
  source_bank_name text,
  total_count      bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_role   text;
  v_limit  integer;
  v_offset integer;
BEGIN
  -- 1. Authentication. No caller-supplied user id exists anywhere in this
  --    signature; the recipient is always auth.uid().
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'An organization context is required.';
  END IF;

  -- 2. Active membership in the requested organization.
  --    role::text cast avoids the app_role enum comparison error (Hotfix 03 pattern).
  SELECT om.role::text
  INTO   v_role
  FROM   public.organization_memberships om
  WHERE  om.organization_id = p_organization_id
    AND  om.user_id         = v_uid
    AND  om.is_active       = true
  LIMIT  1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Caller has no active membership in this organization.';
  END IF;

  -- 3. Employee role only. Admins, cashiers, engineers and hierarchy reviewers
  --    have their own surfaces and must not borrow this one.
  IF v_role <> 'employee' THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'This endpoint serves employees only.';
  END IF;

  -- 4. Server-side feature gate. Absent organization_features row = disabled.
  IF NOT public.org_feature_enabled(p_organization_id, 'employee_transfer_history') THEN
    RAISE EXCEPTION 'feature_disabled'
      USING HINT = 'employee_transfer_history is not enabled for this organization.';
  END IF;

  -- 5. Bounded pagination. Clamp rather than trust the caller.
  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  -- 6. Credits addressed to this user in this organization, newest first.
  --    credited_by_name is resolved by a single LEFT JOIN inside the function —
  --    never one profile lookup per row from the browser.
  RETURN QUERY
  SELECT
    cth.id,
    cth.amount,
    cth.transferred_at,
    cth.payment_mode,
    cth.transfer_type,
    creditor.name AS credited_by_name,
    cth.source_bank_name_snapshot AS source_bank_name,
    COUNT(*) OVER () AS total_count
  FROM public.cash_transfer_history cth
  LEFT JOIN public.profiles creditor
         ON creditor.user_id         = cth.transferrer_id
        AND creditor.organization_id = cth.organization_id
  WHERE cth.organization_id = p_organization_id
    AND cth.recipient_id    = v_uid
  ORDER BY cth.transferred_at DESC, cth.id DESC
  LIMIT  v_limit
  OFFSET v_offset;
END;
$$;

-- Index review (no new index added):
--   idx_cash_transfer_history_recipient (recipient_id, transferred_at DESC)
--   already exists from 20250129000000_create_cash_transfer_history.sql and is
--   the natural access path here. recipient_id is the highly selective term —
--   one user's own credits — and the index supplies transferred_at DESC
--   ordering directly, so the planner reads an already-sorted prefix and applies
--   organization_id as a cheap residual filter on the few rows returned.
--   A (organization_id, recipient_id, transferred_at DESC, id) composite would
--   duplicate that access path for no measurable gain at realistic per-employee
--   row counts, so it is deliberately omitted. Revisit only if a single user's
--   credit count grows large enough for the residual org filter to matter.

REVOKE ALL ON FUNCTION public.get_my_balance_transfer_history(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_balance_transfer_history(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_balance_transfer_history(uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_my_balance_transfer_history(uuid, integer, integer) IS
  'Employee-safe balance credit history. Returns only cash_transfer_history rows '
  'where recipient_id = auth.uid() in the given organization. Requires active '
  'employee membership and the employee_transfer_history organization feature. '
  'Takes no user-id parameter; exposes no bank account numbers, notes, emails or '
  'transfer-date edit metadata.';
