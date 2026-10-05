-- Additive Credit Accounting V3 -- unified, chronologically-reconstructed
-- balance timeline (part 3).
--
-- Replaces trusting stored balance_after values with a server-computed
-- running balance over the COMPLETE canonical event set for one employee,
-- built BEFORE pagination (a LIMIT-then-sum would make every page after the
-- first wrong). The event set is:
--   - balance_ledger rows for this org+user, MINUS any row that is part of
--     a reversed pair (works for both the old anchor engine and the new v3
--     credit engine -- see "hidden" CTE -- so employees never see the
--     "historical_balance_update / historical_anchor_reversal" noise, or a
--     future "balance_credit / credit_reversal" pair, generically, for
--     every organization and employee, not any specific one).
--   - expense_balance_deductions for this org+user, joined to expenses for
--     the canonical business date (expenses.trip_start) and transaction
--     number (expenses.transaction_number) -- the SAME fields the Expense
--     table itself displays. Approval time (expense_balance_deductions.
--     created_at) is never used for positioning, only as audit metadata.
--
-- Same-day ordering is deterministic and generic:
--   day_position 0 (Opening Credit) < day_position 1 (ordinary events,
--   including expense deductions, tie-broken by the expense's own
--   transaction number) < day_position 2 (Balance/Tally Credit).
--
-- Pagination happens strictly AFTER the running balance is computed over
-- the full set (see the `running` CTE using a window function, evaluated
-- before the outer LIMIT/OFFSET).

BEGIN;

-- A `RETURNS TABLE(...)` function does not create a nameable composite type
-- -- an explicit type is required so both this function and its two public
-- wrappers can declare `RETURNS SETOF <this type>`.
DROP TYPE IF EXISTS public.balance_timeline_event_v3 CASCADE;
CREATE TYPE public.balance_timeline_event_v3 AS (
  event_id               uuid,
  event_type             text,
  amount_delta           numeric,
  effective_at           timestamptz,
  day_position           smallint,
  source_type            text,
  source_id              uuid,
  note                   text,
  actor_name             text,
  expense_id             uuid,
  transaction_number     text,
  calculated_balance_after numeric,
  total_count            bigint
);

CREATE OR REPLACE FUNCTION public._balance_unified_timeline_v3(
  p_organization_id uuid,
  p_user_id         uuid,
  p_limit           integer,
  p_offset          integer
)
RETURNS SETOF public.balance_timeline_event_v3
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH hidden AS (
    -- Generic, org/employee-independent rule: a reversed original and its
    -- reversal never appear in the normal timeline, for either engine.
    SELECT id FROM public.balance_ledger WHERE reversal_of IS NOT NULL
    UNION
    SELECT reversal_of FROM public.balance_ledger WHERE reversal_of IS NOT NULL
    UNION
    SELECT id FROM public.balance_ledger
    WHERE source_type = 'historical_anchor'
      AND source_id IN (SELECT id FROM public.balance_historical_anchors WHERE status = 'reversed')
  ),
  events AS (
    SELECT
      bl.id AS event_id, bl.entry_type AS event_type, bl.amount_delta,
      bl.effective_at, bl.day_position, bl.source_type, bl.source_id, bl.note,
      actor.name AS actor_name, NULL::uuid AS expense_id, NULL::text AS transaction_number
    FROM public.balance_ledger bl
    LEFT JOIN public.profiles actor
           ON actor.user_id = bl.actor_user_id AND actor.organization_id = bl.organization_id
    WHERE bl.organization_id = p_organization_id
      AND bl.user_id = p_user_id
      AND bl.id NOT IN (SELECT id FROM hidden)

    UNION ALL

    SELECT
      ebd.id, 'expense_deduction', (-ebd.expense_amount),
      e.trip_start::timestamptz, 1::smallint, 'expense_approval', ebd.expense_id, NULL::text,
      approver.name, ebd.expense_id, e.transaction_number
    FROM public.expense_balance_deductions ebd
    JOIN public.expenses e ON e.id = ebd.expense_id
    LEFT JOIN public.profiles approver
           ON approver.user_id = ebd.approved_by AND approver.organization_id = ebd.organization_id
    WHERE ebd.organization_id = p_organization_id
      AND ebd.employee_user_id = p_user_id
  ),
  ordered AS (
    SELECT e.*,
      ROW_NUMBER() OVER (
        ORDER BY
          e.effective_at::date ASC,
          e.day_position ASC,
          (CASE WHEN e.event_type = 'expense_deduction' THEN e.transaction_number END) ASC NULLS LAST,
          e.effective_at ASC,
          e.event_id ASC
      ) AS rn
    FROM events e
  ),
  totals AS (
    SELECT COALESCE(SUM(amount_delta), 0) AS total_delta, COUNT(*) AS cnt FROM events
  ),
  baseline AS (
    SELECT COALESCE(p.balance, 0) - t.total_delta AS baseline_before
    FROM public.profiles p, totals t
    WHERE p.user_id = p_user_id AND p.organization_id = p_organization_id
  ),
  running AS (
    SELECT
      o.*,
      b.baseline_before + SUM(o.amount_delta) OVER (ORDER BY o.rn) AS calculated_balance_after
    FROM ordered o, baseline b
  )
  SELECT
    r.event_id, r.event_type, r.amount_delta, r.effective_at, r.day_position,
    r.source_type, r.source_id, r.note, r.actor_name, r.expense_id, r.transaction_number,
    r.calculated_balance_after, (SELECT cnt FROM totals) AS total_count
  FROM running r
  ORDER BY r.rn DESC
  LIMIT p_limit OFFSET p_offset;
$$;

REVOKE ALL ON FUNCTION public._balance_unified_timeline_v3(uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_unified_timeline_v3(uuid, uuid, integer, integer) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_unified_balance_timeline_v3(
  p_organization_id uuid,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
)
RETURNS SETOF public.balance_timeline_event_v3
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE user_id = v_uid AND organization_id = p_organization_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;
  RETURN QUERY SELECT * FROM public._balance_unified_timeline_v3(
    p_organization_id, v_uid, LEAST(GREATEST(p_limit, 1), 200), GREATEST(p_offset, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_unified_balance_timeline_v3(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_unified_balance_timeline_v3(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_unified_balance_timeline_v3(uuid, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_org_balance_timeline_v3(
  p_organization_id uuid,
  p_user_id         uuid,
  p_limit           integer DEFAULT 25,
  p_offset          integer DEFAULT 0
)
RETURNS SETOF public.balance_timeline_event_v3
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT role::text INTO v_role FROM public.organization_memberships
  WHERE user_id = v_uid AND organization_id = p_organization_id AND is_active = true
  LIMIT 1;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only an organization admin may view another employee''s balance timeline';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE user_id = p_user_id AND organization_id = p_organization_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Target user is not an active member of this organization';
  END IF;
  RETURN QUERY SELECT * FROM public._balance_unified_timeline_v3(
    p_organization_id, p_user_id, LEAST(GREATEST(p_limit, 1), 200), GREATEST(p_offset, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_org_balance_timeline_v3(uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_balance_timeline_v3(uuid, uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_org_balance_timeline_v3(uuid, uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.get_my_unified_balance_timeline_v3(uuid, integer, integer) IS
  'Additive V3 unified timeline (self, own history). Checked by name in balance_additive_v3_capabilities_v1.';
COMMENT ON FUNCTION public.get_org_balance_timeline_v3(uuid, uuid, integer, integer) IS
  'Additive V3 unified timeline (admin view of one employee). Checked by name in balance_additive_v3_capabilities_v1.';

COMMIT;
