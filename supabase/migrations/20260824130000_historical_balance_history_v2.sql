-- Historical Balance Anchors V2 -- history reads.
--
-- get_my_unified_balance_history_v1 / get_org_balance_ledger_v1
-- (20260819165000, 20260820150000) already surface every
-- historical_opening/historical_balance_update/historical_anchor_* ledger
-- row (their entry_type filters are additive, not restrictive) -- but a
-- ledger row only carries the DELTA (amount_delta), not the anchor's
-- TARGET (stated_balance). Without the target, the UI cannot show
-- "Balance Update: Known balance ₹1,500, Adjustment +₹300" -- only the
-- +₹300 half. These v2 functions LEFT JOIN balance_historical_anchors
-- (via source_type='historical_anchor', source_id=anchors.id) to add that
-- context as nullable extra columns; every other row shape is identical to
-- v1. v1 stays live and unedited for any caller that has not moved over.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_my_unified_balance_history_v2(
  p_organization_id uuid,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
)
RETURNS TABLE (
  event_id              uuid,
  event_type            text,
  amount_delta          numeric,
  balance_after         numeric,
  effective_at          timestamptz,
  source_type           text,
  source_id             uuid,
  note                  text,
  actor_name            text,
  anchor_kind           text,
  anchor_stated_balance numeric,
  anchor_effective_date date,
  anchor_status         text,
  total_count           bigint
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
  WITH combined AS (
    SELECT
      bl.id AS event_id, bl.entry_type AS event_type, bl.amount_delta, bl.balance_after,
      bl.effective_at, bl.source_type, bl.source_id, bl.note, actor.name AS actor_name,
      anc.anchor_kind, anc.stated_balance AS anchor_stated_balance,
      anc.effective_date AS anchor_effective_date, anc.status AS anchor_status
    FROM public.balance_ledger bl
    LEFT JOIN public.profiles actor
           ON actor.user_id = bl.actor_user_id AND actor.organization_id = bl.organization_id
    LEFT JOIN public.balance_historical_anchors anc
           ON bl.source_type = 'historical_anchor' AND anc.id = bl.source_id
    WHERE bl.organization_id = p_organization_id AND bl.user_id = v_uid

    UNION ALL

    SELECT
      ebd.id, 'expense_deduction', -ebd.expense_amount, ebd.balance_after,
      ebd.created_at, 'expense_approval', ebd.expense_id, NULL::text, approver.name,
      NULL::text, NULL::numeric, NULL::date, NULL::text
    FROM public.expense_balance_deductions ebd
    LEFT JOIN public.profiles approver
           ON approver.user_id = ebd.approved_by AND approver.organization_id = ebd.organization_id
    WHERE ebd.organization_id = p_organization_id AND ebd.employee_user_id = v_uid
  )
  SELECT combined.*, COUNT(*) OVER () AS total_count
  FROM combined
  ORDER BY combined.effective_at DESC, combined.event_id DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_unified_balance_history_v2(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_unified_balance_history_v2(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_unified_balance_history_v2(uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_my_unified_balance_history_v2(uuid, integer, integer) IS
  'Historical Balance Anchors V2. Identical to get_my_unified_balance_history_v1 '
  '(own-row-only, same combined pagination) with anchor_kind/'
  'anchor_stated_balance/anchor_effective_date/anchor_status added via a '
  'LEFT JOIN on balance_historical_anchors -- NULL for every non-anchor '
  'event. Lets the UI show a Balance Update''s TARGET alongside its '
  'ledgered ADJUSTMENT delta, instead of only the delta.';

CREATE OR REPLACE FUNCTION public.get_org_balance_ledger_v2(
  p_organization_id uuid,
  p_user_id         uuid DEFAULT NULL,
  p_limit           integer DEFAULT 50,
  p_offset          integer DEFAULT 0
)
RETURNS TABLE (
  id                    uuid,
  user_id               uuid,
  employee_id           text,
  employee_name         text,
  entry_type            text,
  amount_delta          numeric,
  balance_before        numeric,
  balance_after         numeric,
  effective_at          timestamptz,
  note                  text,
  source_type           text,
  source_id             uuid,
  actor_name            text,
  anchor_kind           text,
  anchor_stated_balance numeric,
  anchor_effective_date date,
  anchor_status         text,
  total_count           bigint
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
    anc.anchor_kind, anc.stated_balance AS anchor_stated_balance,
    anc.effective_date AS anchor_effective_date, anc.status AS anchor_status,
    COUNT(*) OVER () AS total_count
  FROM public.balance_ledger bl
  LEFT JOIN public.profiles p ON p.user_id = bl.user_id AND p.organization_id = bl.organization_id
  LEFT JOIN public.profiles actor ON actor.user_id = bl.actor_user_id AND actor.organization_id = bl.organization_id
  LEFT JOIN public.balance_historical_anchors anc
         ON bl.source_type = 'historical_anchor' AND anc.id = bl.source_id
  WHERE bl.organization_id = p_organization_id
    AND (p_user_id IS NULL OR bl.user_id = p_user_id)
  ORDER BY bl.effective_at DESC, bl.id DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_org_balance_ledger_v2(uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_balance_ledger_v2(uuid, uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_org_balance_ledger_v2(uuid, uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_org_balance_ledger_v2(uuid, uuid, integer, integer) IS
  'Historical Balance Anchors V2. Identical to get_org_balance_ledger_v1 '
  '(admin-only, organization-scoped drill-down) with anchor_kind/'
  'anchor_stated_balance/anchor_effective_date/anchor_status added via a '
  'LEFT JOIN on balance_historical_anchors -- NULL for every non-anchor row.';

COMMIT;

NOTIFY pgrst, 'reload schema';
