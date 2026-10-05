-- Detailed Expense V4: legacy expenses now genuinely debit the running
-- balance, with an explicit, transparent, report-only reconciliation model
-- instead of a zero-delta workaround (owner "final accounting-consistency
-- fix", 2026-09-23).
--
-- ============================================================================
-- WHY THIS REPLACES THE PREVIOUS V4 BALANCE MODEL
--
-- The prior pass (20260926000000_detailed_expense_rows_v4.sql) made every
-- legacy expense (no expense_balance_deductions row) a real, fully-detailed
-- report row but gave it a BALANCE-AFFECTING delta of exactly 0 -- a
-- deliberately cautious choice at the time, because this database has no
-- historical_opening/anchor rows for Patidar and it was not yet proven
-- whether the legacy expenses' effect was already reflected in the current
-- wallet balance.
--
-- That question has since been answered by a completed, 31-gate forensic
-- audit (Patidar, 2026-09-20; see Documentations MD/detailed-expense-report-preview.md
-- for the summary). Its Model C ("old software actual behavior") reproduces
-- ALL 16 employees' current balances and 2,599/2,599 independent historical
-- observations exactly: the legacy expenses DID debit balances, every one of
-- them, under the old software. A zero-delta legacy row was therefore
-- financially wrong -- it hid a real, proven historical debit.
--
-- ============================================================================
-- THE MODEL THIS MIGRATION IMPLEMENTS
--
-- 1. Every expense (legacy AND modern) now has a REAL delta: -total_amount.
--    Debit always equals the expense's own amount. Opening/Closing Balance
--    move by exactly that amount, for every expense row, with no exception.
--
-- 2. The "carried-in balance before this employee's earliest known event" is
--    no longer hidden arithmetic (the old baseline_before term folded
--    silently into a SUM() starting point) -- it is now an explicit,
--    visible report row, `historical_opening_balance`, computed as
--    `current_profiles_balance - SUM(every other known signed event for
--    this employee)`. This is REPORT-ONLY: it is a row in this function's
--    OUTPUT, never written to balance_ledger, profiles.balance, or any
--    other accounting table. It guarantees the row-arithmetic invariant
--    (Opening + Credit - Debit = Closing) holds for every row including
--    itself, and guarantees the final Closing Balance always reconciles to
--    the real current balance -- exactly the same guarantee the OLD hidden
--    baseline_before term already made, just made honest and auditable
--    instead of invisible.
--
-- 3. A new, generic, report-only table -- `report_historical_reconciliation_events`
--    -- lets a small number of INDEPENDENTLY PROVEN historical facts be
--    represented as their own explicit, separately-labeled rows instead of
--    being silently absorbed into the single opening-balance residual. This
--    migration seeds it with the audit's 3 PROVEN duplicate-deduction cases
--    (Dipa txn 01090 ₹487, Pravin txn 01162 ₹2,000, Mahendrasinh txn 01267
--    ₹3,738 -- the old software's read-then-write approval race deducted
--    each of these expenses' amount from the wallet TWICE, though only one
--    expense record exists for each). This table is empty by default for
--    every other organization -- nothing here is Patidar-specific in the
--    SQL itself; the 3 rows are DATA, inserted the same way any future
--    admin-confirmed historical fact would be.
--
-- 4. What this migration deliberately does NOT attempt: precisely modeling
--    the March 2026 zero-balance discontinuity as a mid-timeline event.
--    The audit proves the EFFECT (every employee holding a balance was at
--    exactly ₹0.00 in a specific 6-hour window on 2026-03-02) but does NOT
--    prove which statement, run by whom, produced it, and reconstructing it
--    precisely would require replaying events in ACTUAL PROCESSING order
--    (approval time), not trip_start order -- which conflicts with the
--    owner's own explicit, non-negotiable business-date rule for this
--    report (trip_start governs display and ordering). Rather than
--    fabricate a precise placement this migration cannot support with
--    confidence, the single opening-balance residual above honestly
--    absorbs this uncertainty: every expense still shows its real debit,
--    every row's arithmetic still holds, and the final balance still
--    reconciles exactly -- but the report does not claim to show the exact
--    historical shape of the March discontinuity. This is the explicit,
--    documented trade-off the owner's own brief allows ("if exact placement
--    cannot be supported confidently: do not fabricate precision; document
--    the unresolved interval; but never make ordinary expense Debit rows
--    zero-delta").
--
-- ADDITIVE AND FORWARD-ONLY: does not edit the previous V4 migration file,
-- report_balance_timeline_rows_v3, or _balance_timeline_events_v3.
-- _balance_event_label_v3 is extended (CREATE OR REPLACE) with two new
-- label mappings for the two new event types this migration introduces --
-- a pure, backward-compatible addition: no existing entry_type string's
-- label changes, so every existing caller (Balance Ledger UI included) is
-- unaffected.

-- ── 1. Report-only reconciliation events (never accounting truth) ─────────
CREATE TABLE IF NOT EXISTS public.report_historical_reconciliation_events (
  id                        uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id           uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_type                text NOT NULL CHECK (event_type IN ('duplicate_deduction_error', 'historical_balance_adjustment')),
  effective_date            date NOT NULL,
  amount_delta              numeric NOT NULL,
  display_label             text NOT NULL,
  note                      text NOT NULL,
  related_transaction_number text,
  confidence                text NOT NULL DEFAULT 'proven' CHECK (confidence IN ('proven', 'conditional')),
  created_by                uuid REFERENCES auth.users (id),
  created_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.report_historical_reconciliation_events IS
  'Report-only historical facts for Detailed Expense V4 -- NEVER accounting truth, never read by balance_ledger/profiles.balance/any live balance computation, never written by any financial RPC. Exists solely so a small number of independently-proven historical facts (e.g. a known duplicate deduction) can be shown as their own explicit, labeled report row instead of being silently absorbed into the generic opening-balance residual. Empty for every organization except where a fact has actually been proven and entered.';

ALTER TABLE public.report_historical_reconciliation_events ENABLE ROW LEVEL SECURITY;
-- No client policies at all -- worker/service_role only, same posture as
-- report_export_job_rows. There is no client-facing RPC for this table in
-- this pass; a future admin UI would add one deliberately, not by accident.
REVOKE ALL ON public.report_historical_reconciliation_events FROM PUBLIC;
REVOKE ALL ON public.report_historical_reconciliation_events FROM anon, authenticated;
GRANT SELECT ON public.report_historical_reconciliation_events TO service_role;

-- ── 2. Extend the shared label helper (additive only) ──────────────────────
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
    -- New, report-only-context labels (Detailed Expense V4 only; these
    -- entry_type strings are never written to balance_ledger itself).
    WHEN 'historical_opening_balance'      THEN 'Historical Opening Balance'
    WHEN 'duplicate_deduction_error'       THEN 'Duplicate Deduction (Historical)'
    WHEN 'historical_balance_adjustment'   THEN 'Historical Balance Adjustment'
    ELSE COALESCE(p_entry_type, '')
  END;
$fn$;

REVOKE ALL ON FUNCTION public._balance_event_label_v3(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_event_label_v3(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._balance_event_label_v3(text) TO service_role;

-- ── 3. V4 row producer, corrected balance model ─────────────────────────────
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
SET search_path = public
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
    SELECT user_id, event_id, event_type, amount_delta, amount_delta AS amount_delta_display,
           effective_at, day_position, note, actor_name, expense_id, transaction_number,
           false AS modern_deduction_present
    FROM public._balance_timeline_events_v3(p_organization_id, p_user_ids)
    WHERE event_type <> 'expense_deduction'
  ),
  expense_events AS (
    -- Every APPROVED, valid-profile expense is a row, whether or not a
    -- modern expense_balance_deductions record exists -- and its delta is
    -- ALWAYS real: -total_amount. modern_deduction_present is diagnostic
    -- only (section 17 of the prior pass); it no longer changes the delta.
    SELECT
      e.user_id,
      e.id                                                        AS event_id,
      'expense_deduction'::text                                   AS event_type,
      (-e.total_amount)                                            AS amount_delta,
      (-e.total_amount)                                            AS amount_delta_display,
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
  reconciliation_events AS (
    -- Independently-proven historical facts (e.g. the audit's 3 duplicate
    -- deductions), each its own explicit, separately-labeled row -- never
    -- silently folded into the generic opening-balance residual below.
    SELECT
      r.user_id,
      r.id                                                          AS event_id,
      r.event_type,
      r.amount_delta,
      r.amount_delta                                                AS amount_delta_display,
      r.effective_date::timestamptz                                 AS effective_at,
      1::smallint                                                    AS day_position,
      (r.note || CASE WHEN r.confidence = 'conditional' THEN ' (conditional -- see documentation)' ELSE '' END) AS note,
      ''::text                                                        AS actor_name,
      NULL::uuid                                                      AS expense_id,
      COALESCE(r.related_transaction_number, '')                      AS transaction_number,
      false                                                            AS modern_deduction_present
    FROM public.report_historical_reconciliation_events r
    WHERE r.organization_id = p_organization_id
      AND (p_user_ids IS NULL OR r.user_id = ANY (p_user_ids))
  ),
  events AS (
    SELECT * FROM non_expense_events
    UNION ALL
    SELECT * FROM expense_events
    UNION ALL
    SELECT * FROM reconciliation_events
  ),
  totals AS (
    SELECT user_id, COALESCE(SUM(amount_delta), 0) AS total_delta FROM events GROUP BY user_id
  ),
  earliest_event AS (
    SELECT user_id, min(effective_at) AS earliest_at FROM events GROUP BY user_id
  ),
  opening_balance_events AS (
    -- REPORT-ONLY reconciliation row: makes the "carried-in balance before
    -- this employee's earliest known event" explicit and auditable instead
    -- of a hidden SUM() starting point. Never written to any accounting
    -- table. Dated one day before the earliest event so it always sorts
    -- first; naturally drops out of a report window that starts after it
    -- (its delta still correctly feeds the running balance either way --
    -- the window filter runs strictly after this calculation).
    SELECT
      t.user_id,
      gen_random_uuid()                                              AS event_id,
      'historical_opening_balance'::text                             AS event_type,
      (COALESCE(p.balance, 0) - t.total_delta)                        AS amount_delta,
      (COALESCE(p.balance, 0) - t.total_delta)                        AS amount_delta_display,
      (ee.earliest_at - interval '1 day')                             AS effective_at,
      0::smallint                                                     AS day_position,
      'Reconciles to the current balance -- represents the net effect of all activity before the earliest event this report can see. Report-only: never written to any accounting table.' AS note,
      ''::text                                                        AS actor_name,
      NULL::uuid                                                      AS expense_id,
      NULL::text                                                      AS transaction_number,
      false                                                            AS modern_deduction_present
    FROM totals t
    JOIN earliest_event ee ON ee.user_id = t.user_id
    LEFT JOIN public.profiles p ON p.user_id = t.user_id AND p.organization_id = p_organization_id
  ),
  all_events AS (
    SELECT * FROM events
    UNION ALL
    SELECT * FROM opening_balance_events
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
    FROM all_events e
  ),
  running AS (
    -- No separate baseline term any more -- the opening_balance_events row
    -- IS the starting point, as a real row in the sequence.
    SELECT o.*,
           SUM(o.amount_delta) OVER (PARTITION BY o.user_id ORDER BY o.rn) AS calculated_balance_after
    FROM ordered o
  ),
  windowed AS (
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
             'credit',                    CASE WHEN pg.amount_delta_display > 0 THEN  pg.amount_delta_display END,
             'debit',                     CASE WHEN pg.amount_delta_display < 0 THEN -pg.amount_delta_display END,
             'opening_balance',           pg.calculated_balance_after - pg.amount_delta,
             'closing_balance',           pg.calculated_balance_after,
             'note',                      COALESCE(pg.note, ''),
             'actor_name',                COALESCE(pg.actor_name, ''),
             'transaction_number',        COALESCE(e.transaction_number, pg.transaction_number, ''),
             'expense_id',                pg.expense_id,
             'title',                     COALESCE(e.title, ''),
             'category',                  COALESCE(e.category, ''),
             'purpose',                   COALESCE(e.purpose, ''),
             'destination',               COALESCE(e.destination, ''),
             'batch_ref',                 COALESCE(NULLIF(btrim(eb.label), ''), ''),
             'custom_fields',             CASE WHEN pg.expense_id IS NULL THEN '{}'::jsonb
                                               ELSE COALESCE((SELECT map FROM custom) -> pg.expense_id::text, '{}'::jsonb) END,
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

REVOKE ALL ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) TO service_role;

COMMENT ON FUNCTION public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean) IS
  'Detailed Expense V4 row producer, corrected balance model (2026-09-23):'
  ' every APPROVED expense -- legacy or modern -- has a real balance-affecting'
  ' delta (-total_amount); the carried-in balance before an employee''s'
  ' earliest known event is an explicit, report-only historical_opening_balance'
  ' row rather than hidden arithmetic; independently-proven historical facts'
  ' (report_historical_reconciliation_events) get their own explicit rows.'
  ' Nothing here writes to any accounting table. service_role only.';

-- ── 4. Seed the 3 independently-proven Patidar duplicate deductions ────────
-- From the 2026-09-20 forensic audit (31/31 gates): the old software's
-- read-then-write approval race deducted each of these three expenses'
-- amount from the wallet TWICE, though each has only one expense record.
-- Data only -- no SQL logic anywhere is Patidar-specific; any other
-- organization's table stays empty until a fact is independently proven
-- for it the same way.
INSERT INTO public.report_historical_reconciliation_events
  (organization_id, user_id, event_type, effective_date, amount_delta, display_label, note, related_transaction_number, confidence)
VALUES
  ('496fb7f7-d789-44c9-9be8-675ddf186302', '03f07950-aba9-46b6-bd97-8fe3fc874086', 'duplicate_deduction_error', '2026-04-17', -487.00,
   'Duplicate Deduction (Historical)',
   'Old-software read-then-write approval race deducted transaction 01090''s amount from the wallet a second time. Proven by the 2026-09-20 forensic audit (independent balance-observation reconciliation, 31/31 gates) -- the recorded balance fell twice for this single expense.',
   '01090', 'proven'),
  ('496fb7f7-d789-44c9-9be8-675ddf186302', '817ab46a-b7c2-40f7-9919-44312f5ee27f', 'duplicate_deduction_error', '2026-04-29', -2000.00,
   'Duplicate Deduction (Historical)',
   'Old-software read-then-write approval race deducted transaction 01162''s amount from the wallet a second time. Proven by the 2026-09-20 forensic audit (independent balance-observation reconciliation, 31/31 gates) -- the recorded balance fell twice for this single expense.',
   '01162', 'proven'),
  ('496fb7f7-d789-44c9-9be8-675ddf186302', 'a9b7b211-35d3-491c-b56a-f47a204257f0', 'duplicate_deduction_error', '2026-05-08', -3738.00,
   'Duplicate Deduction (Historical)',
   'Old-software read-then-write approval race deducted transaction 01267''s amount from the wallet a second time. Proven by the 2026-09-20 forensic audit (independent balance-observation reconciliation, 31/31 gates) -- the recorded balance fell twice for this single expense.',
   '01267', 'proven')
ON CONFLICT DO NOTHING;

DO $verify$
BEGIN
  IF to_regclass('public.report_historical_reconciliation_events') IS NULL THEN
    RAISE EXCEPTION 'report_historical_reconciliation_events table missing';
  END IF;
  IF to_regprocedure('public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean)') IS NULL THEN
    RAISE EXCEPTION 'report_detailed_expense_rows_v4 missing';
  END IF;
  IF has_table_privilege('anon', 'public.report_historical_reconciliation_events', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not have access to report_historical_reconciliation_events';
  END IF;
  IF has_table_privilege('authenticated', 'public.report_historical_reconciliation_events', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not have access to report_historical_reconciliation_events (worker/service_role only)';
  END IF;
  IF has_function_privilege('anon', 'public.report_detailed_expense_rows_v4(uuid, uuid[], date, date, jsonb, integer, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on report_detailed_expense_rows_v4';
  END IF;
  IF (SELECT count(*) FROM public.report_historical_reconciliation_events WHERE organization_id = '496fb7f7-d789-44c9-9be8-675ddf186302') <> 3 THEN
    RAISE EXCEPTION 'expected exactly 3 seeded reconciliation events for Patidar';
  END IF;
  RAISE NOTICE 'detailed_expense_v4_balance_reconciliation migration verified OK';
END;
$verify$;
