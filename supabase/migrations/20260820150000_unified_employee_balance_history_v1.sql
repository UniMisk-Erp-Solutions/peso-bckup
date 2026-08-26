-- DOC-099 — financial path closure pass, corrective migration #6.
--
-- useEmployeeBalanceLedger previously paginated balance_ledger and
-- expense_balance_deductions independently (page/pageSize applied to each
-- source separately) then merged client-side -- that does not produce
-- correct global chronological pagination: page 2 could be missing events
-- that belong on page 1, or repeat/skip rows, once both sources have enough
-- history. Replaced with one read-only server RPC that UNIONs both sources
-- BEFORE ordering/paginating, so LIMIT/OFFSET apply to the true combined
-- timeline. Employee may read ONLY their own events -- no financial
-- mutation, no change to review_approve_expense_v2 or any balance RPC.

CREATE OR REPLACE FUNCTION public.get_my_unified_balance_history_v1(
  p_organization_id uuid,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
)
RETURNS TABLE (
  event_id      uuid,
  event_type    text,
  amount_delta  numeric,
  balance_after numeric,
  effective_at  timestamptz,
  source_type   text,
  source_id     uuid,
  note          text,
  actor_name    text,
  total_count   bigint
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
      bl.id            AS event_id,
      bl.entry_type    AS event_type,
      bl.amount_delta  AS amount_delta,
      bl.balance_after AS balance_after,
      bl.effective_at  AS effective_at,
      bl.source_type   AS source_type,
      bl.source_id     AS source_id,
      bl.note          AS note,
      actor.name       AS actor_name
    FROM public.balance_ledger bl
    LEFT JOIN public.profiles actor
           ON actor.user_id = bl.actor_user_id AND actor.organization_id = bl.organization_id
    WHERE bl.organization_id = p_organization_id
      AND bl.user_id = v_uid

    UNION ALL

    SELECT
      ebd.id                AS event_id,
      'expense_deduction'   AS event_type,
      -ebd.expense_amount   AS amount_delta,
      ebd.balance_after     AS balance_after,
      ebd.created_at        AS effective_at,
      'expense_approval'    AS source_type,
      ebd.expense_id        AS source_id,
      NULL::text             AS note,
      approver.name          AS actor_name
    FROM public.expense_balance_deductions ebd
    LEFT JOIN public.profiles approver
           ON approver.user_id = ebd.approved_by AND approver.organization_id = ebd.organization_id
    WHERE ebd.organization_id = p_organization_id
      AND ebd.employee_user_id = v_uid
  )
  SELECT
    combined.event_id,
    combined.event_type,
    combined.amount_delta,
    combined.balance_after,
    combined.effective_at,
    combined.source_type,
    combined.source_id,
    combined.note,
    combined.actor_name,
    COUNT(*) OVER () AS total_count
  FROM combined
  ORDER BY combined.effective_at DESC, combined.event_id DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_unified_balance_history_v1(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_unified_balance_history_v1(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_unified_balance_history_v1(uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_my_unified_balance_history_v1(uuid, integer, integer) IS
  'DOC-099. Read-only, own-row-only, chronologically-correct global '
  'pagination over balance_ledger UNION ALL expense_balance_deductions for '
  'the calling employee. Replaces useEmployeeBalanceLedger''s client-side '
  'two-source merge, which paginated each source independently and could '
  'not guarantee correct page boundaries once both sources had history.';

NOTIFY pgrst, 'reload schema';
