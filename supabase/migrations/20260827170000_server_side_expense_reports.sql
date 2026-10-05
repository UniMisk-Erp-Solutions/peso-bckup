-- Server-side report generation, part 3 of 4 — row production and enqueue
-- for Claim Verification, Claim Approval and Detailed Expense.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- Additive only: four new functions, all worker/enqueue surfaces. No existing
-- table, column, RLS policy or grant is modified.
-- ============================================================================
--
-- INTEGRATION PROVENANCE
--
-- Ported from `origin/feature/preet-patel-changes`
-- (`20260822120000_server_side_expense_reports.sql`), with three adaptations
-- made while porting, not blindly copied:
--
-- 1. The source migration's `report_type` CHECK constraint widening
--    (`daily_project_report` -> all four types) is dropped here because
--    `report_export_jobs` already allows all four types from its creation in
--    part 1 of this integration -- there is no narrower constraint left to
--    widen.
-- 2. `create_expense_report_export_job_v1` gained the same explicit
--    `REVOKE ALL ... FROM PUBLIC` / `REVOKE ALL ... FROM anon` pattern every
--    other authenticated-only function in this codebase uses (the source
--    migration only granted to `authenticated`, without the matching
--    revokes -- functionally low-risk since the function immediately raises
--    on `auth.uid() IS NULL`, but inconsistent with the established
--    convention and tightened here to match it).
-- 3. `create_expense_report_export_job_v1` gained the `WHEN unique_violation`
--    race handler that `create_daily_project_report_export_job_v1` (part 1)
--    already has. The source migration's version had no such handler, so two
--    truly concurrent enqueues with an identical dedupe key could raise an
--    unhandled `unique_violation` against `report_export_jobs_active_dedupe_idx`
--    instead of both resolving to the same job.
--
-- Everything else -- the row producer's keyset pagination, the custom-field
-- resolution, the allocations helper -- is unchanged from the source branch.
--
-- DEDUPE SCOPE, BY DESIGN, DIFFERS FROM THE DAILY REPORT
--
-- The Daily Project Report's dedupe key includes the requesting user
-- (per-user dedupe: two people asking for the same daily report each get
-- their own job). This function's dedupe key does NOT include the requester
-- (org-wide dedupe: two people in the same org asking for Claim Verification
-- with identical filters share one job). This is intentional, not an
-- oversight -- the RLS SELECT policy on report_export_jobs already lets any
-- caller who can view a report type see every job of that type in their org,
-- so sharing a deduplicated job across requesters within the same
-- organization introduces no new access. Flagged here so a future reader
-- does not "fix" it into an inconsistency with the daily report.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Helpers ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._report_humanize_field_key_v1(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT initcap(replace(replace(COALESCE(p_key, ''), '_', ' '), '-', ' '));
$$;

CREATE OR REPLACE FUNCTION public._report_expense_custom_fields_v1(
  p_organization_id uuid,
  p_expense_ids     uuid[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      v.expense_id::text,
      field_map
    ),
    '{}'::jsonb
  )
  FROM (
    SELECT
      v.expense_id,
      jsonb_object_agg(
        COALESCE(
          NULLIF(btrim(t.name), ''),
          NULLIF(btrim(public._report_humanize_field_key_v1(t.field_key)), ''),
          NULLIF(btrim(b.name), ''),
          NULLIF(btrim(public._report_humanize_field_key_v1(b.field_key)), ''),
          'Custom field'
        ),
        v.field_value
      ) AS field_map
    FROM public.expense_form_field_values v
    LEFT JOIN public.expense_form_field_templates t ON t.id = v.template_id
    LEFT JOIN public.expense_form_field_option_branches b ON b.id = v.branch_field_id
    WHERE v.organization_id = p_organization_id
      AND v.expense_id = ANY (p_expense_ids)
      AND btrim(COALESCE(v.field_value, '')) <> ''
    GROUP BY v.expense_id
  ) v
  GROUP BY v.expense_id, v.field_map;
$$;

REVOKE ALL ON FUNCTION public._report_humanize_field_key_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._report_humanize_field_key_v1(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._report_humanize_field_key_v1(text) TO service_role;

REVOKE ALL ON FUNCTION public._report_expense_custom_fields_v1(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._report_expense_custom_fields_v1(uuid, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._report_expense_custom_fields_v1(uuid, uuid[]) TO service_role;


-- ── Row producer (worker-only, no auth.uid() gate by design) ────────────────
-- Keyset/cursor pagination on (sort_val, id) DESC -- a proper composite
-- comparison, so ties on the sort column cannot skip or duplicate rows.
CREATE OR REPLACE FUNCTION public.report_expense_rows_v1(
  p_organization_id uuid,
  p_statuses        text[],
  p_category        text    DEFAULT NULL,
  p_user_ids        uuid[]  DEFAULT NULL,
  p_date_from       date    DEFAULT NULL,
  p_date_to         date    DEFAULT NULL,
  p_sort_column     text    DEFAULT 'created_at',
  p_cursor          jsonb   DEFAULT NULL,
  p_page_size       integer DEFAULT 250,
  p_with_total      boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_size     integer := LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 500);
  v_sort_col text    := CASE WHEN p_sort_column = 'trip_start' THEN 'trip_start' ELSE 'created_at' END;
  v_cur_val  timestamptz := NULL;
  v_cur_id   uuid    := NULL;
  v_out      jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL THEN
    IF jsonb_typeof(p_cursor) <> 'object' THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
    v_cur_val := NULLIF(p_cursor ->> 'v', '')::timestamptz;
    v_cur_id  := NULLIF(p_cursor ->> 'id', '')::uuid;
    IF v_cur_val IS NULL OR v_cur_id IS NULL THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  WITH filtered AS (
    SELECT e.id, e.user_id, e.title, e.total_amount, e.status, e.created_at,
           e.trip_start, e.trip_end, e.category, e.purpose, e.destination,
           e.transaction_number, e.batch_id,
           CASE WHEN v_sort_col = 'trip_start' THEN e.trip_start::timestamptz ELSE e.created_at END AS sort_val
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status = ANY (p_statuses)
      AND (p_category IS NULL OR e.category ILIKE p_category)
      AND (p_user_ids IS NULL OR e.user_id = ANY (p_user_ids))
      AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
      AND (p_date_to IS NULL OR e.trip_start <= p_date_to)
      AND (
        p_cursor IS NULL
        OR (CASE WHEN v_sort_col = 'trip_start' THEN e.trip_start::timestamptz ELSE e.created_at END, e.id)
           < (v_cur_val, v_cur_id)
      )
    ORDER BY sort_val DESC, e.id DESC
    LIMIT v_size
  ),
  ids AS (SELECT array_agg(id) AS arr FROM filtered),
  custom AS (
    SELECT public._report_expense_custom_fields_v1(p_organization_id, COALESCE((SELECT arr FROM ids), ARRAY[]::uuid[])) AS map
  ),
  rows_json AS (
    SELECT jsonb_agg(jsonb_build_object(
             'id', f.id,
             'user_id', f.user_id,
             'user_name', COALESCE(pr.name, ''),
             'user_email', COALESCE(pr.email, ''),
             'employee_id', COALESCE(pr.employee_id, ''),
             'user_balance', COALESCE(pr.balance, 0),
             'title', f.title,
             'total_amount', COALESCE(f.total_amount, 0),
             'status', f.status,
             'created_at', f.created_at,
             'trip_start', f.trip_start,
             'trip_end', f.trip_end,
             'category', f.category,
             'purpose', f.purpose,
             'destination', f.destination,
             'transaction_number', f.transaction_number,
             'batch_ref', COALESCE(NULLIF(btrim(eb.label), ''), '-'),
             'custom_fields', COALESCE((SELECT map FROM custom) -> f.id::text, '{}'::jsonb)
           ) ORDER BY f.sort_val DESC, f.id DESC) AS arr,
           count(*) AS n
    FROM filtered f
    LEFT JOIN public.profiles pr ON pr.user_id = f.user_id AND pr.organization_id = p_organization_id
    LEFT JOIN public.expense_batches eb ON eb.id = f.batch_id
  ),
  last_row AS (
    SELECT sort_val, id FROM filtered ORDER BY sort_val ASC, id ASC LIMIT 1
  ),
  tot AS (
    SELECT CASE WHEN COALESCE(p_with_total, false) THEN (
      SELECT count(*) FROM public.expenses e
      WHERE e.organization_id = p_organization_id
        AND e.status = ANY (p_statuses)
        AND (p_category IS NULL OR e.category ILIKE p_category)
        AND (p_user_ids IS NULL OR e.user_id = ANY (p_user_ids))
        AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
        AND (p_date_to IS NULL OR e.trip_start <= p_date_to)
    ) END AS total
  )
  SELECT jsonb_build_object(
    'schema_version', 1,
    'snapshot_at', now(),
    'returned', COALESCE((SELECT n FROM rows_json), 0),
    'page_size', v_size,
    'has_more', COALESCE((SELECT n FROM rows_json), 0) = v_size,
    'next_cursor', CASE WHEN COALESCE((SELECT n FROM rows_json), 0) = v_size
                        THEN (SELECT jsonb_build_object('v', sort_val, 'id', id) FROM last_row)
                        ELSE NULL END,
    'total_count', (SELECT total FROM tot),
    'rows', COALESCE((SELECT arr FROM rows_json), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.report_expense_rows_v1(uuid, text[], text, uuid[], date, date, text, jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_expense_rows_v1(uuid, text[], text, uuid[], date, date, text, jsonb, integer, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_expense_rows_v1(uuid, text[], text, uuid[], date, date, text, jsonb, integer, boolean) TO service_role;

COMMENT ON FUNCTION public.report_expense_rows_v1(uuid, text[], text, uuid[], date, date, text, jsonb, integer, boolean) IS
  'Worker-only row producer for Claim Verification, Claim Approval and '
  'Detailed Expense. Performs NO authorization -- service_role only. '
  'Authorization happened at enqueue (create_expense_report_export_job_v1).';


-- ── Allocations (Detailed Expense, single-employee ledger) ──────────────────
CREATE OR REPLACE FUNCTION public.report_expense_allocations_v1(
  p_organization_id uuid,
  p_user_id         uuid,
  p_date_from       date DEFAULT NULL,
  p_date_to         date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', h.id,
    'amount', h.amount,
    'transferred_at', h.transferred_at,
    'transfer_type', h.transfer_type,
    'transferrer_id', h.transferrer_id,
    'recipient_id', h.recipient_id,
    'notes', h.notes
  ) ORDER BY h.transferred_at), '[]'::jsonb)
  FROM public.cash_transfer_history h
  WHERE h.organization_id = p_organization_id
    AND (h.transferrer_id = p_user_id OR h.recipient_id = p_user_id)
    AND (p_date_from IS NULL OR h.transferred_at::date >= p_date_from)
    AND (p_date_to IS NULL OR h.transferred_at::date <= p_date_to);
$$;

REVOKE ALL ON FUNCTION public.report_expense_allocations_v1(uuid, uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_expense_allocations_v1(uuid, uuid, date, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_expense_allocations_v1(uuid, uuid, date, date) TO service_role;


-- ── Enqueue (Claim Verification / Claim Approval / Detailed Expense only --
--    Daily Project Report has its own enqueue function, part 1) ────────────
CREATE OR REPLACE FUNCTION public.create_expense_report_export_job_v1(
  p_organization_id uuid,
  p_report_type     text,
  p_filters         jsonb   DEFAULT '{}'::jsonb,
  p_team_scoped     boolean DEFAULT false,
  p_format          text    DEFAULT 'csv'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_team     boolean := COALESCE(p_team_scoped, false);
  v_format   text := lower(COALESCE(p_format, 'csv'));
  v_dedupe   text;
  v_existing public.report_export_jobs%ROWTYPE;
  v_job_id   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_report_type NOT IN ('claim_verification', 'claim_approval', 'detailed_expense') THEN
    RAISE EXCEPTION 'unsupported report type for this function' USING ERRCODE = '22023';
  END IF;
  IF v_format NOT IN ('csv', 'xlsx') THEN
    RAISE EXCEPTION 'unsupported format' USING ERRCODE = '22023';
  END IF;

  -- Permission is resolved from auth.uid(), never from anything the client sent.
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, v_team) THEN
    RAISE EXCEPTION 'not permitted to generate this report' USING ERRCODE = '42501';
  END IF;

  -- Org-wide dedupe (no requester in the key) -- see the file header note.
  v_dedupe := md5(
    p_organization_id::text || '|' || p_report_type || '|' || v_format || '|' || COALESCE(p_filters, '{}'::jsonb)::text
  );

  SELECT * INTO v_existing
  FROM public.report_export_jobs
  WHERE dedupe_key = v_dedupe AND status IN ('queued', 'running')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('job_id', v_existing.id, 'status', v_existing.status, 'deduplicated', true);
  END IF;

  INSERT INTO public.report_export_jobs (
    organization_id, requested_by, report_type, format, parameters, dedupe_key, status
  ) VALUES (
    p_organization_id, v_uid, p_report_type, v_format, COALESCE(p_filters, '{}'::jsonb), v_dedupe, 'queued'
  )
  RETURNING id INTO v_job_id;

  RETURN jsonb_build_object('job_id', v_job_id, 'status', 'queued', 'deduplicated', false);
EXCEPTION
  -- Lost a race against a concurrent identical enqueue: return the winner.
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM public.report_export_jobs
    WHERE dedupe_key = v_dedupe AND status IN ('queued', 'running')
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('job_id', v_existing.id, 'status', v_existing.status, 'deduplicated', true);
    END IF;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.create_expense_report_export_job_v1(uuid, text, jsonb, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_expense_report_export_job_v1(uuid, text, jsonb, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_expense_report_export_job_v1(uuid, text, jsonb, boolean, text) TO authenticated;
