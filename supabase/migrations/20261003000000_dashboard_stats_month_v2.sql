-- Dashboard Month filter: ONE versioned, server-side stats RPC
-- (`get_dashboard_stats_v2`) so the Dashboard KPI cards can represent a
-- selected calendar month as a single consistent snapshot.
--
-- ============================================================================
-- SEMANTICS (owner spec "Dashboard Month Filter")
--
--   * Expense date = expenses.trip_start (never created_at/approved_at/...).
--     Half-open month bounds: from <= trip_start < to_exclusive.
--   * Interval cards (Total Expenses, Pending Amount, Pending Approvals,
--     Pending Reviews) aggregate expenses DATED in the month whose CURRENT
--     status qualifies (status is NOT reconstructed "as of month end" -- the
--     system has no status history to do that honestly).
--   * Current Balance is a POINT-IN-TIME value, not an interval aggregate:
--       - All time, or a month that has not ended yet (current/future):
--         the live profiles.balance (exactly today's Dashboard value).
--       - A month that has ended: the balance as of that month's last day,
--         computed with the SAME canonical event model Detailed Expense V4
--         uses (see `_dashboard_balances_as_of_v1`). It is NEVER
--         "current balance minus the month's expenses".
--   * Total Employee/Manager/Cashier Balance for a finished month = sum of
--     each active member's month-end balance, classified by CURRENT active
--     membership role (organization_memberships keeps no role history, so a
--     historical role classification is not reconstructable -- documented
--     limitation, nothing fabricated).
--
-- ALL TIME PARITY: with p_month_from/p_month_to_exclusive NULL, every value
-- equals what get_dashboard_expense_summary / get_org_role_balance_totals /
-- the live profile balance / the engineer pending-review paths return today.
--
-- ADDITIVE ONLY: get_dashboard_expense_summary and get_org_role_balance_totals
-- are untouched, so the current Production frontend keeps working.
--
-- SECURITY: identity comes from auth.uid(); the caller must be an ACTIVE
-- member of p_organization_id; role is read from that membership. Anon has no
-- EXECUTE. SECURITY DEFINER is needed only to reuse the service_role-only
-- canonical balance event source; every read is explicitly scoped to the
-- caller's own organization (and, for non-admins, the caller's own rows).

-- ── 1. Month-end balances, canonical V4 event model ─────────────────────────
-- Balance of user U after every canonical event dated < p_to_exclusive:
--   events = non-expense timeline events (balance_ledger)
--          + every APPROVED, non-deleted expense at -total_amount, dated trip_start
--          + report_historical_reconciliation_events
--          + the explicit `historical_opening_balance` residual row
--            (current balance - sum of every other event), dated one day
--            before the user's earliest event
-- -- exactly the composition report_detailed_expense_rows_v4 uses, so the
-- final Closing Balance through a date equals this value to the paisa.
-- A member with NO known event at all is unchanged by anything known, so
-- their balance as of any date is their current balance.
CREATE OR REPLACE FUNCTION public._dashboard_balances_as_of_v1(
  p_organization_id uuid,
  p_user_ids        uuid[],
  p_to_exclusive    date
)
RETURNS TABLE (user_id uuid, balance_as_of numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH events AS (
    SELECT t.user_id, t.amount_delta, t.effective_at
    FROM public._balance_timeline_events_v3(p_organization_id, p_user_ids) t
    WHERE t.event_type <> 'expense_deduction'
    UNION ALL
    SELECT e.user_id, (-e.total_amount), e.trip_start::timestamptz
    FROM public.expenses e
    JOIN public.profiles pr
      ON pr.user_id = e.user_id AND pr.organization_id = e.organization_id
    WHERE e.organization_id = p_organization_id
      AND e.status = 'approved'
      AND e.deleted_at IS NULL
      AND (p_user_ids IS NULL OR e.user_id = ANY (p_user_ids))
    UNION ALL
    SELECT r.user_id, r.amount_delta, r.effective_date::timestamptz
    FROM public.report_historical_reconciliation_events r
    WHERE r.organization_id = p_organization_id
      AND (p_user_ids IS NULL OR r.user_id = ANY (p_user_ids))
  ),
  per_user AS (
    SELECT user_id, SUM(amount_delta) AS total_delta, MIN(effective_at) AS earliest_at
    FROM events GROUP BY user_id
  ),
  opening AS (
    SELECT pu.user_id,
           (COALESCE(p.balance, 0) - pu.total_delta) AS amount_delta,
           (pu.earliest_at - interval '1 day')       AS effective_at
    FROM per_user pu
    LEFT JOIN public.profiles p
      ON p.user_id = pu.user_id AND p.organization_id = p_organization_id
  ),
  all_events AS (
    SELECT user_id, amount_delta, effective_at FROM events
    UNION ALL
    SELECT user_id, amount_delta, effective_at FROM opening
  ),
  before_cutoff AS (
    SELECT user_id, SUM(amount_delta) AS bal
    FROM all_events
    WHERE effective_at::date < p_to_exclusive
    GROUP BY user_id
  )
  SELECT p.user_id,
         CASE WHEN pu.user_id IS NULL THEN COALESCE(p.balance, 0)
              ELSE COALESCE(bc.bal, 0) END AS balance_as_of
  FROM public.profiles p
  LEFT JOIN per_user pu ON pu.user_id = p.user_id
  LEFT JOIN before_cutoff bc ON bc.user_id = p.user_id
  WHERE p.organization_id = p_organization_id
    AND (p_user_ids IS NULL OR p.user_id = ANY (p_user_ids));
$fn$;

REVOKE ALL ON FUNCTION public._dashboard_balances_as_of_v1(uuid, uuid[], date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._dashboard_balances_as_of_v1(uuid, uuid[], date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._dashboard_balances_as_of_v1(uuid, uuid[], date) TO service_role;

COMMENT ON FUNCTION public._dashboard_balances_as_of_v1(uuid, uuid[], date) IS
  'Internal: per-user balance after every canonical event dated before p_to_exclusive, same event model as report_detailed_expense_rows_v4 (parity-tested). Not client-callable.';

-- ── 2. The Dashboard stats RPC ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_dashboard_stats_v2(
  p_organization_id     uuid,
  p_month_from          date DEFAULT NULL,
  p_month_to_exclusive  date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_role    text;
  v_scoped  boolean;
  v_today   date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_live    boolean;
  v_admin   boolean;

  v_total          numeric := 0;
  v_count          bigint  := 0;
  v_pending        numeric := 0;
  v_approved       numeric := 0;
  v_pend_appr      bigint  := 0;
  v_pend_appr_amt  numeric := 0;

  v_rev_count      bigint  := NULL;
  v_rev_amount     numeric := NULL;
  v_overview       jsonb;

  v_balance        numeric := 0;
  v_role_totals    jsonb   := NULL;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;

  SELECT m.role::text INTO v_role
  FROM public.organization_memberships m
  WHERE m.organization_id = p_organization_id
    AND m.user_id = v_uid
    AND m.is_active = true
  LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'not an active member of this organization' USING ERRCODE = '42501';
  END IF;
  v_admin := (v_role = 'admin');

  -- Month window: both bounds or neither; an exact calendar month only.
  IF (p_month_from IS NULL) <> (p_month_to_exclusive IS NULL) THEN
    RAISE EXCEPTION 'month bounds must be supplied together' USING ERRCODE = '22023';
  END IF;
  v_scoped := (p_month_from IS NOT NULL);
  IF v_scoped THEN
    IF p_month_from <> date_trunc('month', p_month_from)::date
       OR p_month_to_exclusive <> (p_month_from + interval '1 month')::date THEN
      RAISE EXCEPTION 'bounds must be an exact calendar month' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- A month that has not finished yet has no month-end balance to report:
  -- the live balance is the honest value.
  v_live := (NOT v_scoped) OR (p_month_to_exclusive > v_today);

  -- ── Interval cards: expenses dated (trip_start) in the month ──
  SELECT
    COALESCE(SUM(e.total_amount), 0),
    COUNT(*),
    COALESCE(SUM(e.total_amount) FILTER (WHERE e.status IN ('submitted', 'verified')), 0),
    COALESCE(SUM(e.total_amount) FILTER (WHERE e.status = 'approved'), 0),
    COUNT(*) FILTER (WHERE e.status = 'verified'
                        OR (e.status = 'submitted' AND e.assigned_engineer_id IS NULL)),
    COALESCE(SUM(e.total_amount) FILTER (WHERE e.status = 'verified'
                        OR (e.status = 'submitted' AND e.assigned_engineer_id IS NULL)), 0)
  INTO v_total, v_count, v_pending, v_approved, v_pend_appr, v_pend_appr_amt
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.deleted_at IS NULL
    AND (v_admin OR e.user_id = v_uid)
    AND (NOT v_scoped OR (e.trip_start >= p_month_from AND e.trip_start < p_month_to_exclusive));

  -- ── Engineer pending reviews (same two paths the Dashboard has today) ──
  IF v_role = 'engineer' THEN
    IF public.org_feature_enabled(p_organization_id, 'teams_enabled')
       OR public.org_feature_enabled(p_organization_id, 'approval_hierarchy') THEN
      -- Team/hierarchy path: the caller's team members come from the
      -- existing list_my_teams_overview (one source of truth for who is on
      -- the caller's teams). That RPC does not date-scope pending, so the
      -- pending count/amount is recomputed here by trip_start. Members are
      -- kept once PER TEAM so the all-time number equals the old client sum
      -- exactly (including a member who sits on two teams).
      v_overview := public.list_my_teams_overview(p_organization_id);
      SELECT COALESCE(SUM(x.cnt), 0), COALESCE(SUM(x.total), 0)
      INTO v_rev_count, v_rev_amount
      FROM (
        SELECT (mem ->> 'user_id')::uuid AS member_id
        FROM jsonb_array_elements(COALESCE(v_overview -> 'teams', '[]'::jsonb)) AS team,
             jsonb_array_elements(COALESCE(team -> 'members', '[]'::jsonb)) AS mem
      ) m
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::bigint AS cnt, COALESCE(SUM(e.total_amount), 0) AS total
        FROM public.expenses e
        WHERE e.organization_id = p_organization_id
          AND e.user_id = m.member_id
          AND e.deleted_at IS NULL
          AND public.my_teams_expense_is_pending(e.status)
          AND (NOT v_scoped OR (e.trip_start >= p_month_from AND e.trip_start < p_month_to_exclusive))
      ) x;
    ELSE
      SELECT COUNT(*)::bigint, COALESCE(SUM(e.total_amount), 0)
      INTO v_rev_count, v_rev_amount
      FROM public.expenses e
      WHERE e.assigned_engineer_id = v_uid
        AND e.status = 'submitted'
        AND e.deleted_at IS NULL
        AND (NOT v_scoped OR (e.trip_start >= p_month_from AND e.trip_start < p_month_to_exclusive));
    END IF;
  END IF;

  -- ── Balances (point-in-time) ──
  IF v_live THEN
    SELECT COALESCE(p.balance, 0) INTO v_balance
    FROM public.profiles p
    WHERE p.user_id = v_uid AND p.organization_id = p_organization_id
    LIMIT 1;
    v_balance := COALESCE(v_balance, 0);
  ELSE
    SELECT COALESCE(b.balance_as_of, 0) INTO v_balance
    FROM public._dashboard_balances_as_of_v1(p_organization_id, ARRAY[v_uid], p_month_to_exclusive) b
    WHERE b.user_id = v_uid;
    v_balance := COALESCE(v_balance, 0);
  END IF;

  IF v_admin THEN
    IF v_live THEN
      SELECT jsonb_build_object(
        'employee', COALESCE(SUM(p.balance) FILTER (WHERE m.role = 'employee'), 0),
        'engineer', COALESCE(SUM(p.balance) FILTER (WHERE m.role = 'engineer'), 0),
        'cashier',  COALESCE(SUM(p.balance) FILTER (WHERE m.role = 'cashier'), 0))
      INTO v_role_totals
      FROM public.profiles p
      JOIN public.organization_memberships m
        ON m.user_id = p.user_id AND m.organization_id = p_organization_id AND m.is_active = true
      WHERE p.organization_id = p_organization_id;
    ELSE
      SELECT jsonb_build_object(
        'employee', COALESCE(SUM(b.balance_as_of) FILTER (WHERE m.role = 'employee'), 0),
        'engineer', COALESCE(SUM(b.balance_as_of) FILTER (WHERE m.role = 'engineer'), 0),
        'cashier',  COALESCE(SUM(b.balance_as_of) FILTER (WHERE m.role = 'cashier'), 0))
      INTO v_role_totals
      FROM public._dashboard_balances_as_of_v1(p_organization_id, NULL, p_month_to_exclusive) b
      JOIN public.organization_memberships m
        ON m.user_id = b.user_id AND m.organization_id = p_organization_id AND m.is_active = true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'schema_version',           1,
    'total_amount',             v_total,
    'expense_count',            v_count,
    'pending_amount',           v_pending,
    'approved_amount',          v_approved,
    'pending_approvals',        v_pend_appr,
    'pending_approvals_amount', v_pend_appr_amt,
    'pending_reviews',          v_rev_count,
    'pending_reviews_amount',   v_rev_amount,
    'current_balance',          v_balance,
    'role_balance_totals',      v_role_totals,
    'scope', jsonb_build_object(
      'role',                v_role,
      'month_from',          p_month_from,
      'month_to_exclusive',  p_month_to_exclusive,
      'balance_basis',       CASE WHEN v_live THEN 'live' ELSE 'month_end' END,
      'balance_as_of',       CASE WHEN v_live THEN NULL ELSE (p_month_to_exclusive - 1) END
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_dashboard_stats_v2(uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dashboard_stats_v2(uuid, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats_v2(uuid, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_dashboard_stats_v2(uuid, date, date) IS
  'Dashboard KPI snapshot, optionally scoped to one calendar month (trip_start). Interval cards aggregate expenses dated in the month at their CURRENT status; Current Balance / role balance totals are point-in-time (live for All time and unfinished months, canonical month-end otherwise). Identity from auth.uid(). Additive: get_dashboard_expense_summary / get_org_role_balance_totals are unchanged.';

DO $verify$
BEGIN
  IF to_regprocedure('public.get_dashboard_stats_v2(uuid, date, date)') IS NULL THEN
    RAISE EXCEPTION 'get_dashboard_stats_v2 missing';
  END IF;
  IF has_function_privilege('anon', 'public.get_dashboard_stats_v2(uuid, date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on get_dashboard_stats_v2';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_dashboard_stats_v2(uuid, date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must have EXECUTE on get_dashboard_stats_v2';
  END IF;
  IF has_function_privilege('authenticated', 'public._dashboard_balances_as_of_v1(uuid, uuid[], date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._dashboard_balances_as_of_v1(uuid, uuid[], date)', 'EXECUTE') THEN
    RAISE EXCEPTION '_dashboard_balances_as_of_v1 must be service_role only';
  END IF;
  RAISE NOTICE 'dashboard_stats_month_v2 migration verified OK';
END;
$verify$;

NOTIFY pgrst, 'reload schema';
