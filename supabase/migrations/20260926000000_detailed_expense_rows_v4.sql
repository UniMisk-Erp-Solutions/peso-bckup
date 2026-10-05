-- Detailed Expense V4: every APPROVED expense is a source row, not only the
-- ones that happen to have a modern expense_balance_deductions row.
--
-- ============================================================================
-- THE BUG THIS FIXES
--
-- report_balance_timeline_rows_v3 (Detailed Expense's row producer) reads its
-- expense-shaped events exclusively from expense_balance_deductions:
--
--   SELECT ... FROM public.expense_balance_deductions ebd
--   JOIN public.expenses e ON e.id = ebd.expense_id ...
--
-- expense_balance_deductions only started being written once the modern
-- balance-ledger deduction path existed. For Patidar (the acceptance
-- dataset, chosen because its historical truth is independently known) that
-- is 650 of 2,924 valid approved expenses -- the other 2,274 are APPROVED,
-- REAL, and simply never produced a deduction row, so V3 has never been able
-- to see them. A generated "All Employees, 2026" report showed 734 rows
-- (650 expense_deduction + 83 cash_transfer_in + 1 opening_credit) against
-- 2,836 valid approved 2026 expenses -- confirmed by direct count, not
-- assumed.
--
-- ============================================================================
-- WHY A NEW FUNCTION, NOT AN EDIT TO V3
--
-- _balance_timeline_events_v3 / _balance_unified_timeline_v3 are shared with
-- the live Balance Ledger fe ature (EmployeeBalanceHistory.tsx) and are
-- NOT touched by this migration -- not their body, not their signature, not
-- their grants. This migration adds a Detailed-Expense-only sibling,
-- report_detailed_expense_rows_v4, which REUSES
-- _balance_timeline_events_v3 for every NON-expense event (cash transfers,
-- opening credits, adjustments, reversorhidden-pair handling -- all of it,
-- unchanged) and replaces only the expense-shaped portion with one sourced
-- directly from `expenses`.
--
-- ============================================================================
-- THE LEGACY-BALANCE JUDGMENT CALL -- READ THIS BEFORE CHANGING ANYTHING
--
-- For Patidar, `balance_ledger` contains NO historical_opening / anchor-style
-- reconciliation rows at all (checked directly) -- only 83 cash_transfer_in
-- and 1 opening_credit. That means the per-employee "baseline_before"
-- reconstruction (profiles.balance - sum(existing ledger deltas)) was
-- computed, and has always been correct for the LIVE Balance Ledger feature,
-- WITHOUT the 2,274 legacy expenses ever being subtracted as ledger deltas.
-- Two explanations are both consistent with the data, and this migration
-- cannot distinguish them from inside the database alone:
--
--   (a) the legacy expenses' financial effect was applied to profiles.balance
--       directly by old code, outside any ledger table, and is therefore
--       ALREADY fully reflected in the current balance -- adding a new delta
--       for each one now would double-count it and corrupt every later
--       Closing Balance in the report; or
--   (b) the legacy expenses' financial effect was genuinely never applied to
--       the wallet at all, and profiles.balance has always overstated the
--       true balance by their sum.
--
-- Silently picking (b) and adding 2,274 new negative deltas would corrupt the
-- Closing Balance column for a feature that is otherwise correct and already
-- trusted (Balance Ledger, Balances page) -- exactly the kind of mistake this
-- task explicitly warns against. This migration therefore takes the ONLY
-- choice that cannot corrupt a currently-correct number: a legacy approved
-- expense (no expense_balance_deductions row) is surfaced as its own,
-- fully-detailed report row (title/category/purpose/destination/custom
-- fields/transaction number, real amount shown in the Debit column) with a
-- BALANCE-AFFECTING delta of exactly 0 -- it never moves Opening/Closing
-- Balance, only a MODERN expense (with a real expense_balance_deductions
-- row) does, exactly as before. Each row is tagged
-- `modern_deduction_present` so this is auditable, not hidden. This is
-- reporting/display-only: nothing here writes to expenses, profiles.balance,
-- balance_ledger or expense_balance_deductions, and no synthetic financial
-- event of any kind is fabricated -- see §13 of the task this migration
-- answers to for the exact constraint this satisfies.
--
-- If the owner independently confirms (a) is correct, no further action is
-- needed. If (b) turns out to be correct instead, that is a genuine
-- historical accounting gap outside this report's scope to fix, and would
-- need its own dedicated reconciliation project, not a report change.
-- ============================================================================
--
-- ADDITIVE AND FORWARD-ONLY: no existing table, column, RLS policy, trigger,
-- or financial value is touched. report_balance_timeline_rows_v3 itself is
-- untouched and still exists (nothing currently calls it once the worker
-- switches to v4 in this same release, but it is not dropped).

CREATE OR REPLACE FUNCTION public.report_detailed_expense_rows_v4(
  p_organization_id uuid,
  p_user_ids        uuid[]  DEFAULT NULL,
  p_date_from       date    DEFAULT NULL,
  p_date_to         date    DEFAULT NULL,
  p_cursor          jsonb   DEFAULT NULL,
  p_page_size       integer DEFAULT 250,
  p_with_total      boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_size    integer := LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 500);
  v_cur_nm  text   := NULL;
  v_cur_uid uuid   := NULL;
  v_cur_rn  bigint := NULL;
  v_out     jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;

  IF p_cursor IS NOT NULL THEN
    IF jsonb_typeof(p_cursor) <> 'object' THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
    v_cur_nm  := p_cursor ->> 'n';
    v_cur_uid := NULLIF(p_cursor ->> 'u', '')::uuid;
    v_cur_rn  := NULLIF(p_cursor ->> 'rn', '')::bigint;
    IF v_cur_nm IS NULL OR v_cur_uid IS NULL OR v_cur_rn IS NULL THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  WITH non_expense_events AS (
    -- Every non-expense event, completely untouched: same hidden-pair rule,
    -- same balance_ledger source, same organization/user scoping. This is
    -- the one and only accounting algorithm for these event types; V4 does
    -- not re-derive it.
    SELECT user_id, event_id, event_type, amount_delta, amount_delta AS amount_delta_display,
           effective_at, day_position, note, actor_name, expense_id, transaction_number,
           false AS modern_deduction_present
    FROM public._balance_timeline_events_v3(p_organization_id, p_user_ids)
    WHERE event_type <> 'expense_deduction'
  ),
  expense_events AS (
    -- Every APPROVED, valid-profile expense is a row -- whether or not a
    -- modern expense_balance_deductions record exists for it. Modern
    -- expenses keep their real balance-affecting delta (identical to V3);
    -- legacy expenses (no deduction row) get a display-only row: their real
    -- amount always shows in Debit, but their balance delta is 0 -- see the
    -- judgment-call note above for why.
    SELECT
      e.user_id,
      e.id                                                        AS event_id,
      'expense_deduction'::text                                   AS event_type,
      CASE WHEN ebd.id IS NOT NULL THEN -ebd.expense_amount ELSE 0::numeric END AS amount_delta,
      -e.total_amount                                              AS amount_delta_display,
      e.trip_start::timestamptz                                   AS effective_at,
      1::smallint                                                 AS day_position,
      NULL::text                                                   AS note,
      approver.name                                                AS actor_name,
      e.id                                                          AS expense_id,
      e.transaction_number,
      (ebd.id IS NOT NULL)                                         AS modern_deduction_present
    FROM public.expenses e
    JOIN public.profiles pr
      ON pr.user_id = e.user_id AND pr.organization_id = e.organization_id
    LEFT JOIN public.expense_balance_deductions ebd
      ON ebd.expense_id = e.id
    LEFT JOIN public.profiles approver
      ON approver.user_id = COALESCE(ebd.approved_by, e.approved_by)
     AND approver.organization_id = e.organization_id
    WHERE e.organization_id = p_organization_id
      AND e.status = 'approved'
      AND e.deleted_at IS NULL
      AND (p_user_ids IS NULL OR e.user_id = ANY (p_user_ids))
  ),
  events AS (
    SELECT * FROM non_expense_events
    UNION ALL
    SELECT * FROM expense_events
  ),
  ordered AS (
    SELECT e.*,
      ROW_NUMBER() OVER (
        PARTITION BY e.user_id
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
    -- Balance-affecting delta only (amount_delta, never amount_delta_display)
    -- -- a legacy expense contributes exactly 0 here, by design.
    SELECT user_id, COALESCE(SUM(amount_delta), 0) AS total_delta FROM events GROUP BY user_id
  ),
  baseline AS (
    SELECT t.user_id, COALESCE(p.balance, 0) - t.total_delta AS baseline_before
    FROM totals t
    LEFT JOIN public.profiles p
           ON p.user_id = t.user_id AND p.organization_id = p_organization_id
  ),
  running AS (
    SELECT o.*,
           b.baseline_before + SUM(o.amount_delta) OVER (PARTITION BY o.user_id ORDER BY o.rn)
             AS calculated_balance_after
    FROM ordered o
    JOIN baseline b ON b.user_id = o.user_id
  ),
  windowed AS (
    -- A legacy expense row is ALWAYS kept (it is the entire point of V4) --
    -- every other event type keeps V3's original "zero delta is not a
    -- displayable event" rule.
    SELECT r.*, COALESCE(pr.name, '') AS employee_name, COALESCE(pr.employee_id, '') AS employee_code
    FROM running r
    LEFT JOIN public.profiles pr
           ON pr.user_id = r.user_id AND pr.organization_id = p_organization_id
    WHERE (r.event_type = 'expense_deduction' OR r.amount_delta <> 0)
      AND (p_date_from IS NULL OR r.effective_at::date >= p_date_from)
      AND (p_date_to   IS NULL OR r.effective_at::date <= p_date_to)
  ),
  page AS (
    SELECT * FROM windowed w
    WHERE p_cursor IS NULL
       OR (w.employee_name, w.user_id, w.rn) > (v_cur_nm, v_cur_uid, v_cur_rn)
    ORDER BY w.employee_name ASC, w.user_id ASC, w.rn ASC
    LIMIT v_size
  ),
  exp_ids AS (
    SELECT COALESCE(array_agg(expense_id) FILTER (WHERE expense_id IS NOT NULL), ARRAY[]::uuid[]) AS arr
    FROM page
  ),
  custom AS (
    SELECT public._report_expense_custom_fields_v1(p_organization_id, (SELECT arr FROM exp_ids)) AS map
  ),
  rows_json AS (
    SELECT jsonb_agg(jsonb_build_object(
             'user_id',                   pg.user_id,
             'employee_name',             pg.employee_name,
             'employee_code',             pg.employee_code,
             'event_id',                  pg.event_id,
             'event_type',                pg.event_type,
             'event_label',               public._balance_event_label_v3(pg.event_type),
             'effective_date',            pg.effective_at::date,
             'amount_delta',              pg.amount_delta_display,
             -- Signed accounting rule, applied here once: the SIGN of the
             -- DISPLAY amount decides the column -- a legacy expense still
             -- shows its real Debit even though its balance delta is 0.
             'credit',                    CASE WHEN pg.amount_delta_display > 0 THEN  pg.amount_delta_display END,
             'debit',                     CASE WHEN pg.amount_delta_display < 0 THEN -pg.amount_delta_display END,
             'opening_balance',           pg.calculated_balance_after - pg.amount_delta,
             'closing_balance',           pg.calculated_balance_after,
             'note',                      COALESCE(pg.note, ''),
             'actor_name',                COALESCE(pg.actor_name, ''),
             'transaction_number',        COALESCE(e.transaction_number, ''),
             'expense_id',                pg.expense_id,
             'title',                     COALESCE(e.title, ''),
             'category',                  COALESCE(e.category, ''),
             'purpose',                   COALESCE(e.purpose, ''),
             'destination',               COALESCE(e.destination, ''),
             'batch_ref',                 COALESCE(NULLIF(btrim(eb.label), ''), ''),
             'custom_fields',             CASE WHEN pg.expense_id IS NULL THEN '{}'::jsonb
                                               ELSE COALESCE((SELECT map FROM custom) -> pg.expense_id::text, '{}'::jsonb) END,
             -- Diagnostic only, not a CSV column: lets the worker/tests prove
             -- the legacy population is genuinely included, not just counted.
             'modern_deduction_present',  pg.modern_deduction_present
           ) ORDER BY pg.employee_name ASC, pg.user_id ASC, pg.rn ASC) AS arr,
           count(*) AS n
    FROM page pg
    LEFT JOIN public.expenses e         ON e.id  = pg.expense_id
    LEFT JOIN public.expense_batches eb ON eb.id = e.batch_id
  ),
  last_row AS (
    SELECT employee_name, user_id, rn FROM page
    ORDER BY employee_name DESC, user_id DESC, rn DESC LIMIT 1
  ),
  tot AS (
    SELECT CASE WHEN COALESCE(p_with_total, false)
                THEN (SELECT count(*) FROM windowed) END AS total
  )
  SELECT jsonb_build_object(
    'schema_version', 1,
    'snapshot_at',    now(),
    'returned',       COALESCE((SELECT n FROM rows_json), 0),
    'page_size',      v_size,
    'has_more',       COALESCE((SELECT n FROM rows_json), 0) = v_size,
    'next_cursor',    CASE WHEN COALESCE((SELECT n FROM rows_json), 0) = v_size
                           THEN (SELECT jsonb_build_object('n', employee_name, 'u', user_id, 'rn', rn) FROM last_row)
                           ELSE NULL END,
    'total_count',    (SELECT total FROM tot),
    'rows',           COALESCE((SELECT arr FROM rows_json), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$fn$;

-- Worker-only, identical posture to report_balance_timeline_rows_v3: no
-- authorization of its own, must never be reachable from a browser session.
REVOKE ALL ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) TO service_role;

COMMENT ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) IS
  'Detailed Expense V4 row producer. Every APPROVED, valid-profile expense in '
  'public.expenses is a row (dated by trip_start), whether or not a modern '
  'expense_balance_deductions record exists for it -- V3 only ever saw the '
  'modern subset. Non-expense events (transfers, credits, adjustments) are '
  'reused unchanged from _balance_timeline_events_v3. A legacy expense (no '
  'deduction row) is display-only: its real amount shows in Debit but '
  'contributes 0 to the running balance, to avoid double-counting a possible '
  'pre-ledger balance effect this migration cannot prove either way -- see '
  'the file header. service_role only; authorization happens at enqueue.';

DO $verify$
BEGIN
  IF to_regprocedure('public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean)') IS NULL THEN
    RAISE EXCEPTION 'report_detailed_expense_rows_v4 missing';
  END IF;
  IF to_regprocedure('public.report_balance_timeline_rows_v3(uuid, uuid[], date, date, jsonb, integer, boolean)') IS NULL THEN
    RAISE EXCEPTION 'report_balance_timeline_rows_v3 missing (must not have been dropped)';
  END IF;
  IF to_regprocedure('public._balance_timeline_events_v3(uuid, uuid[])') IS NULL THEN
    RAISE EXCEPTION '_balance_timeline_events_v3 missing (must not have been dropped)';
  END IF;
  IF has_function_privilege('anon', 'public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on report_detailed_expense_rows_v4';
  END IF;
  IF has_function_privilege('authenticated', 'public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not have EXECUTE on report_detailed_expense_rows_v4 (worker/service_role only)';
  END IF;
  RAISE NOTICE 'detailed_expense_rows_v4 migration verified OK';
END;
$verify$;
