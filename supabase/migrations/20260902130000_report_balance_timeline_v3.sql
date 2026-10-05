-- Detailed Expense on the canonical Additive V3 accounting timeline.
--
-- ============================================================================
-- WHY THIS EXISTS
--
-- Detailed Expense used to reconstruct balances itself:
--
--   single employee : approved expenses + report_expense_allocations_v1
--                     (cash_transfer_history) walked BACKWARDS from
--                     rows[0].user_balance
--   all employees   : approved expenses only, Debit column only, and no
--                     closing balance at all
--
-- That architecture predates Additive Credit V3, so it could not see V3
-- positive or negative balance entries, opening-balance credits, Tally/balance
-- additions, or the V3 reversed-pair visibility rules -- and its backward walk
-- from the *present* wallet balance silently mis-stated history whenever any
-- of those existed.
--
-- This migration retires that second accounting algorithm. It introduces ONE
-- canonical event constructor and rewires BOTH consumers onto it:
--
--   _balance_timeline_events_v3   <- the single source of accounting truth
--        |                            (hidden-pair rules + event union)
--        +-- _balance_unified_timeline_v3    (V3 Balance Ledger, unchanged
--        |                                    signature/return/ordering)
--        +-- report_balance_timeline_rows_v3 (Detailed Expense worker)
--
-- ============================================================================
-- ADDITIVE AND FORWARD-ONLY
--
-- No already-live V3 migration file is edited. No table, column, RLS policy,
-- trigger or financial value is touched. _balance_unified_timeline_v3 is
-- CREATE OR REPLACE'd in place with a body that delegates to the shared
-- helper: same signature, same return type, same ordering, same baseline
-- arithmetic, same output. Its row-for-row equivalence with the previous body
-- was proven against Production data before this migration was applied.
-- ============================================================================

BEGIN;

-- == 1. The canonical event constructor =====================================
-- Lifted semantics-for-semantics out of the body of
-- _balance_unified_timeline_v3 as shipped in
-- 20260901123000_unified_balance_timeline_v3.sql, generalised from one
-- employee to a set of employees. Nothing about the accounting changed:
--
--   * the `hidden` CTE is the same generic reversed-pair rule, covering both
--     the old anchor engine and the v3 credit engine;
--   * expense deductions still take their date from expenses.trip_start and
--     their transaction number from expenses.transaction_number, never from
--     the approval timestamp;
--   * day_position is still carried through untouched.
--
-- LANGUAGE sql + STABLE so the planner can inline it into the callers and push
-- the p_user_ids predicate down to the base tables -- the single-employee
-- Balance Ledger path must not start scanning the whole organisation.
CREATE OR REPLACE FUNCTION public._balance_timeline_events_v3(
  p_organization_id uuid,
  p_user_ids        uuid[] DEFAULT NULL
)
RETURNS TABLE (
  user_id            uuid,
  event_id           uuid,
  event_type         text,
  amount_delta       numeric,
  effective_at       timestamptz,
  day_position       smallint,
  source_type        text,
  source_id          uuid,
  note               text,
  actor_name         text,
  expense_id         uuid,
  transaction_number text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
  )
  SELECT
    bl.user_id, bl.id, bl.entry_type, bl.amount_delta,
    bl.effective_at, bl.day_position, bl.source_type, bl.source_id, bl.note,
    actor.name, NULL::uuid, NULL::text
  FROM public.balance_ledger bl
  LEFT JOIN public.profiles actor
         ON actor.user_id = bl.actor_user_id AND actor.organization_id = bl.organization_id
  WHERE bl.organization_id = p_organization_id
    AND (p_user_ids IS NULL OR bl.user_id = ANY (p_user_ids))
    AND bl.id NOT IN (SELECT id FROM hidden)

  UNION ALL

  SELECT
    ebd.employee_user_id, ebd.id, 'expense_deduction', (-ebd.expense_amount),
    e.trip_start::timestamptz, 1::smallint, 'expense_approval', ebd.expense_id, NULL::text,
    approver.name, ebd.expense_id, e.transaction_number
  FROM public.expense_balance_deductions ebd
  JOIN public.expenses e ON e.id = ebd.expense_id
  LEFT JOIN public.profiles approver
         ON approver.user_id = ebd.approved_by AND approver.organization_id = ebd.organization_id
  WHERE ebd.organization_id = p_organization_id
    AND (p_user_ids IS NULL OR ebd.employee_user_id = ANY (p_user_ids));
$fn$;

REVOKE ALL ON FUNCTION public._balance_timeline_events_v3(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_timeline_events_v3(uuid, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._balance_timeline_events_v3(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public._balance_timeline_events_v3(uuid, uuid[]) IS
  'Canonical Additive V3 balance event set (balance_ledger minus reversed pairs, '
  'plus expense_balance_deductions dated by expenses.trip_start). The single '
  'source of accounting truth shared by _balance_unified_timeline_v3 (Balance '
  'Ledger) and report_balance_timeline_rows_v3 (Detailed Expense worker). '
  'Internal: no authorization of its own -- every caller must gate first.';


-- == 2. Human-readable event labels =========================================
-- A verbatim port of ledgerEntryTypeLabel() in
-- src/pages/EmployeeBalanceHistory.tsx so an exported row reads exactly like
-- the same row in the Balance Ledger UI. Sign is NOT consulted here: whether
-- an event lands in Credit or Debit is decided by amount_delta at the call
-- site, never by the label.
CREATE OR REPLACE FUNCTION public._balance_event_label_v3(p_entry_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE p_entry_type
    WHEN 'historical_opening'              THEN 'Opening Balance'
    WHEN 'allocation'                      THEN 'Allocation'
    WHEN 'manual_adjustment'               THEN 'Adjustment'
    WHEN 'cash_transfer_in'                THEN 'Cash Transfer'
    WHEN 'cash_transfer_out'               THEN 'Cash Transfer'
    WHEN 'bank_transfer'                   THEN 'Bank Transfer'
    WHEN 'expense_deduction'               THEN 'Expense Deduction'
    WHEN 'reversal'                        THEN 'Reversal'
    WHEN 'correction'                      THEN 'Correction'
    WHEN 'historical_balance_update'       THEN 'Balance Update'
    WHEN 'historical_anchor_recalculation' THEN 'Balance Recalculation'
    WHEN 'opening_credit'                  THEN 'Opening Balance Credit'
    WHEN 'balance_credit'                  THEN 'Balance Credit'
    WHEN 'credit_reversal'                 THEN 'Reversal'
    ELSE COALESCE(p_entry_type, '')
  END;
$fn$;

REVOKE ALL ON FUNCTION public._balance_event_label_v3(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_event_label_v3(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._balance_event_label_v3(text) TO service_role;


-- == 3. Rewire the Balance Ledger onto the shared helper =====================
-- Same signature, same return type, same ordering key, same baseline
-- arithmetic, same ORDER BY rn DESC + LIMIT/OFFSET. The ONLY change is that
-- the `hidden`/`events` CTEs are now read from _balance_timeline_events_v3
-- instead of being written out a second time here. This is what makes "one
-- accounting algorithm" true rather than aspirational.
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
AS $fn$
  WITH events AS (
    SELECT * FROM public._balance_timeline_events_v3(p_organization_id, ARRAY[p_user_id])
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
$fn$;

-- Grants are re-asserted rather than assumed: CREATE OR REPLACE preserves the
-- existing ACL, but stating them keeps this file self-describing and makes a
-- future replay on a fresh database land in the same place.
REVOKE ALL ON FUNCTION public._balance_unified_timeline_v3(uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_unified_timeline_v3(uuid, uuid, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._balance_unified_timeline_v3(uuid, uuid, integer, integer) TO service_role;


-- == 4. Detailed Expense worker row producer ================================
-- Set-based over every requested employee in ONE call. There is deliberately
-- no per-employee RPC anywhere in this path: "All employees" on a large
-- organisation would otherwise be hundreds of round trips.
--
-- Order of operations matters and is the whole point of the fix:
--
--   1. build the COMPLETE canonical event set (no date filter),
--   2. rank it per employee,
--   3. run the balance forward per employee from that employee's own
--      reconstructed baseline,
--   4. ONLY THEN filter to the requested report window,
--   5. ONLY THEN paginate.
--
-- Filtering first and summing from zero is exactly the bug this replaces: the
-- first in-period row would open at 0 instead of at the true carried-in
-- balance.
--
-- Each employee is ranked and summed independently (PARTITION BY user_id), so
-- there is never one organisation-wide running balance.
CREATE OR REPLACE FUNCTION public.report_balance_timeline_rows_v3(
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

  WITH events AS (
    -- Step 1: the complete canonical set. No date predicate here, on purpose.
    SELECT * FROM public._balance_timeline_events_v3(p_organization_id, p_user_ids)
  ),
  ordered AS (
    -- Step 2: per-employee chronological rank, using the SAME deterministic
    -- same-day ordering key as the Balance Ledger.
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
    SELECT user_id, COALESCE(SUM(amount_delta), 0) AS total_delta FROM events GROUP BY user_id
  ),
  baseline AS (
    -- Step 3a: each employee's own carried-in balance, reconstructed the same
    -- way the Balance Ledger reconstructs it -- backwards from the wallet.
    SELECT t.user_id, COALESCE(p.balance, 0) - t.total_delta AS baseline_before
    FROM totals t
    LEFT JOIN public.profiles p
           ON p.user_id = t.user_id AND p.organization_id = p_organization_id
  ),
  running AS (
    -- Step 3b: forward running balance, independently per employee.
    SELECT o.*,
           b.baseline_before + SUM(o.amount_delta) OVER (PARTITION BY o.user_id ORDER BY o.rn)
             AS calculated_balance_after
    FROM ordered o
    JOIN baseline b ON b.user_id = o.user_id
  ),
  windowed AS (
    -- Step 4: NOW apply the report window. Balances above already carry every
    -- pre-period event. A zero-delta event is a no-op and is not a displayable
    -- financial event, so it is dropped from output only -- it contributes
    -- nothing to the running balance either way.
    SELECT r.*, COALESCE(pr.name, '') AS employee_name, COALESCE(pr.employee_id, '') AS employee_code
    FROM running r
    LEFT JOIN public.profiles pr
           ON pr.user_id = r.user_id AND pr.organization_id = p_organization_id
    WHERE r.amount_delta <> 0
      AND (p_date_from IS NULL OR r.effective_at::date >= p_date_from)
      AND (p_date_to   IS NULL OR r.effective_at::date <= p_date_to)
  ),
  page AS (
    -- Step 5: keyset pagination on the display order. The tuple comparison is
    -- a true composite, so employees with identical names cannot skip or
    -- duplicate rows.
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
             'user_id',            pg.user_id,
             'employee_name',      pg.employee_name,
             'employee_code',      pg.employee_code,
             'event_id',           pg.event_id,
             'event_type',         pg.event_type,
             'event_label',        public._balance_event_label_v3(pg.event_type),
             'effective_date',     pg.effective_at::date,
             'amount_delta',       pg.amount_delta,
             -- Signed accounting rule, applied here once and nowhere else:
             -- the SIGN decides the column, never the event type.
             'credit',             CASE WHEN pg.amount_delta > 0 THEN  pg.amount_delta END,
             'debit',              CASE WHEN pg.amount_delta < 0 THEN -pg.amount_delta END,
             'opening_balance',    pg.calculated_balance_after - pg.amount_delta,
             'closing_balance',    pg.calculated_balance_after,
             'note',               COALESCE(pg.note, ''),
             'actor_name',         COALESCE(pg.actor_name, ''),
             -- transaction_number stays TEXT end to end so leading zeros survive.
             'transaction_number', COALESCE(e.transaction_number, ''),
             'expense_id',         pg.expense_id,
             'title',              COALESCE(e.title, ''),
             'category',           COALESCE(e.category, ''),
             'purpose',            COALESCE(e.purpose, ''),
             'destination',        COALESCE(e.destination, ''),
             'batch_ref',          COALESCE(NULLIF(btrim(eb.label), ''), ''),
             'custom_fields',      CASE WHEN pg.expense_id IS NULL THEN '{}'::jsonb
                                        ELSE COALESCE((SELECT map FROM custom) -> pg.expense_id::text, '{}'::jsonb) END
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

-- Worker-only. This function performs NO authorization of its own -- exactly
-- like report_expense_rows_v1 and report_daily_project_rows_v1 -- because the
-- permission decision already happened at enqueue in
-- create_expense_report_export_job_v1, which resolves it from auth.uid().
-- It must therefore never be reachable by a browser session.
REVOKE ALL ON FUNCTION public.report_balance_timeline_rows_v3(uuid, uuid[], date, date, jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_balance_timeline_rows_v3(uuid, uuid[], date, date, jsonb, integer, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_balance_timeline_rows_v3(uuid, uuid[], date, date, jsonb, integer, boolean) TO service_role;

COMMENT ON FUNCTION public.report_balance_timeline_rows_v3(uuid, uuid[], date, date, jsonb, integer, boolean) IS
  'Worker-only Detailed Expense row producer on the canonical Additive V3 '
  'timeline. Set-based over all requested employees; per-employee independent '
  'running balance; report window applied AFTER the balance is computed so the '
  'first in-period row opens at its true carried-in balance. service_role only '
  '-- authorization happened at enqueue.';

COMMIT;
