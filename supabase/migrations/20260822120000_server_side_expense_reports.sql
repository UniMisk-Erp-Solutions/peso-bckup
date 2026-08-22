-- DOC-105 — server-side generation for the three remaining Reports tabs.
--
-- DOC-102/104 made the Daily Project Report a server job. Claim Verification,
-- Claim Approval and Detailed Expense still paged every row into the browser and
-- built their files there. This adds the server-side pieces those three need.
--
-- Design notes
--   * The row producers are granted to service_role ONLY and carry no auth.uid()
--     gate, exactly like report_daily_project_rows_v1. Authorization happens once,
--     when a permitted user creates the job; a worker has no user context to
--     re-check, and pretending otherwise would be theatre.
--   * The enqueue RPC is the opposite: it runs as the caller and refuses anyone
--     who may not view reports.
--   * Keyset pagination, not OFFSET. These reports are exactly where the silent
--     1000-row PostgREST cap bit before; a cursor cannot silently truncate.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Allow the three new job types.
-- ---------------------------------------------------------------------------
ALTER TABLE public.report_export_jobs
  DROP CONSTRAINT IF EXISTS report_export_jobs_report_type_check;

ALTER TABLE public.report_export_jobs
  ADD CONSTRAINT report_export_jobs_report_type_check
  CHECK (report_type IN (
    'daily_project_report',
    'claim_verification',
    'claim_approval',
    'detailed_expense'
  ));

-- ---------------------------------------------------------------------------
-- 2. Custom field labels, resolved the way the client does:
--    template/branch name, else humanised field_key, else 'Custom field'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._report_humanize_field_key_v1(p_key text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN btrim(COALESCE(p_key, '')) = '' THEN ''
    ELSE initcap(regexp_replace(regexp_replace(btrim(p_key), '[_-]+', ' ', 'g'), '\s+', ' ', 'g'))
  END;
$fn$;

CREATE OR REPLACE FUNCTION public._report_expense_custom_fields_v1(
  p_organization_id uuid,
  p_expense_ids uuid[]
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_object_agg(expense_id, fields), '{}'::jsonb)
  FROM (
    SELECT v.expense_id::text AS expense_id,
           jsonb_object_agg(lbl.label, btrim(v.field_value)) AS fields
    FROM public.expense_form_field_values v
    LEFT JOIN public.expense_form_field_templates t
           ON t.id = v.template_id AND t.organization_id = p_organization_id
    LEFT JOIN public.expense_form_field_option_branches b
           ON b.id = v.branch_field_id AND b.organization_id = p_organization_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        NULLIF(btrim(COALESCE(t.name, '')), ''),
        NULLIF(public._report_humanize_field_key_v1(t.field_key), ''),
        NULLIF(btrim(COALESCE(b.name, '')), ''),
        NULLIF(public._report_humanize_field_key_v1(b.field_key), ''),
        'Custom field'
      ) AS label
    ) lbl
    WHERE v.organization_id = p_organization_id
      AND v.expense_id = ANY(p_expense_ids)
      AND btrim(COALESCE(v.field_value, '')) <> ''
      AND (v.template_id IS NOT NULL OR v.branch_field_id IS NOT NULL)
    GROUP BY v.expense_id
  ) s;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Paged expense rows for the worker.
--    p_sort_column: 'created_at' (verification/approval) | 'trip_start' (detailed)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_expense_rows_v1(
  p_organization_id uuid,
  p_statuses        text[],
  p_category        text        DEFAULT NULL,
  p_user_ids        uuid[]      DEFAULT NULL,
  p_date_from       date        DEFAULT NULL,
  p_date_to         date        DEFAULT NULL,
  p_sort_column     text        DEFAULT 'created_at',
  p_cursor          jsonb       DEFAULT NULL,
  p_page_size       integer     DEFAULT 250,
  p_with_total      boolean     DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_page      integer := LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 500);
  v_trip_sort boolean := (p_sort_column = 'trip_start');
  v_cur_val   timestamptz;
  v_cur_id    uuid;
  v_rows      jsonb;
  v_ids       uuid[];
  v_custom    jsonb;
  v_total     bigint;
  v_returned  integer;
  v_last_val  timestamptz;
  v_last_id   uuid;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;

  IF p_cursor IS NOT NULL THEN
    v_cur_val := (p_cursor->>'v')::timestamptz;
    v_cur_id  := (p_cursor->>'id')::uuid;
  END IF;

  -- A CTE, not a temp table: this function is STABLE and may be called many
  -- times inside one transaction, where a temp table name would collide.
  WITH page AS (
    SELECT e.id, e.user_id, e.title, e.total_amount, e.status, e.created_at,
           e.trip_start, e.trip_end, e.category, e.purpose, e.destination,
           e.transaction_number, e.batch_id,
           (CASE WHEN v_trip_sort THEN e.trip_start::timestamptz ELSE e.created_at END) AS sort_val
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND (p_statuses IS NULL OR e.status::text = ANY(p_statuses))
      AND (p_user_ids IS NULL OR e.user_id = ANY(p_user_ids))
      AND (p_category IS NULL OR e.category ILIKE p_category)
      AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
      AND (p_date_to   IS NULL OR e.trip_start <= p_date_to)
      AND (
        p_cursor IS NULL
        OR ((CASE WHEN v_trip_sort THEN e.trip_start::timestamptz ELSE e.created_at END), e.id)
           < (v_cur_val, v_cur_id)
      )
    ORDER BY sort_val DESC, e.id DESC
    LIMIT v_page
  )
  SELECT array_agg(id), count(*)
    INTO v_ids, v_returned
  FROM page;

  -- The keyset cursor must be the LAST row in sort order, not the max value.
  SELECT sort_val, id INTO v_last_val, v_last_id
  FROM (
    SELECT e.id,
           (CASE WHEN v_trip_sort THEN e.trip_start::timestamptz ELSE e.created_at END) AS sort_val
    FROM public.expenses e
    WHERE e.id = ANY(COALESCE(v_ids, ARRAY[]::uuid[]))
  ) q
  ORDER BY sort_val ASC, id ASC
  LIMIT 1;

  v_custom := COALESCE(
    public._report_expense_custom_fields_v1(p_organization_id, COALESCE(v_ids, ARRAY[]::uuid[])),
    '{}'::jsonb
  );

  SELECT jsonb_agg(to_jsonb(x) ORDER BY x.sort_val DESC, x.id DESC)
    INTO v_rows
  FROM (
    SELECT e.id, e.user_id, e.title, e.total_amount, e.status, e.created_at,
           e.trip_start, e.trip_end, e.category, e.purpose, e.destination,
           e.transaction_number,
           (CASE WHEN v_trip_sort THEN e.trip_start::timestamptz ELSE e.created_at END) AS sort_val,
           COALESCE(p.name, '')        AS user_name,
           COALESCE(p.email, '')       AS user_email,
           COALESCE(p.employee_id, '') AS employee_id,
           COALESCE(p.balance, 0)      AS user_balance,
           COALESCE(NULLIF(btrim(COALESCE(b.label, '')), ''), '-') AS batch_ref,
           COALESCE(v_custom -> e.id::text, '{}'::jsonb)           AS custom_fields
    FROM public.expenses e
    LEFT JOIN public.profiles p
           ON p.user_id = e.user_id AND p.organization_id = p_organization_id
    LEFT JOIN public.expense_batches b ON b.id = e.batch_id
    WHERE e.id = ANY(COALESCE(v_ids, ARRAY[]::uuid[]))
  ) x;

  IF COALESCE(p_with_total, false) THEN
    SELECT count(*) INTO v_total
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND (p_statuses IS NULL OR e.status::text = ANY(p_statuses))
      AND (p_user_ids IS NULL OR e.user_id = ANY(p_user_ids))
      AND (p_category IS NULL OR e.category ILIKE p_category)
      AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
      AND (p_date_to   IS NULL OR e.trip_start <= p_date_to);
  END IF;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'snapshot_at',    now(),
    'rows',           COALESCE(v_rows, '[]'::jsonb),
    'returned',       COALESCE(v_returned, 0),
    'page_size',      v_page,
    'has_more',       COALESCE(v_returned, 0) = v_page,
    'next_cursor',    CASE WHEN COALESCE(v_returned, 0) = v_page AND v_last_id IS NOT NULL
                           THEN jsonb_build_object('v', v_last_val, 'id', v_last_id)
                           ELSE NULL END,
    'total_count',    v_total
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Cash transfers -> the Detailed report credit rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_expense_allocations_v1(
  p_organization_id uuid,
  p_user_id         uuid,
  p_date_from       date DEFAULT NULL,
  p_date_to         date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.transferred_at), '[]'::jsonb)
  FROM (
    SELECT c.id, c.transferred_at, c.amount, c.transfer_type, c.notes,
           c.transferrer_id, c.transferrer_role, c.recipient_id, c.recipient_role
    FROM public.cash_transfer_history c
    WHERE (c.recipient_id = p_user_id OR c.transferrer_id = p_user_id)
      AND (p_date_from IS NULL OR c.transferred_at >= p_date_from::timestamptz)
      AND (p_date_to   IS NULL OR c.transferred_at < (p_date_to + 1)::timestamptz)
  ) x;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Enqueue. Runs as the caller and refuses anyone who may not view reports.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_expense_report_export_job_v1(
  p_organization_id uuid,
  p_report_type     text,
  p_filters         jsonb   DEFAULT '{}'::jsonb,
  p_team_scoped     boolean DEFAULT false,
  p_format          text    DEFAULT 'csv'
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_dedupe   text;
  v_existing public.report_export_jobs%ROWTYPE;
  v_job_id   uuid;
  v_params   jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_report_type NOT IN ('claim_verification', 'claim_approval', 'detailed_expense') THEN
    RAISE EXCEPTION 'unsupported report type: %', p_report_type USING ERRCODE = '22023';
  END IF;
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, COALESCE(p_team_scoped, false)) THEN
    RAISE EXCEPTION 'not permitted to generate this report' USING ERRCODE = '42501';
  END IF;

  v_params := COALESCE(p_filters, '{}'::jsonb);
  v_dedupe := md5(p_organization_id::text || '|' || p_report_type || '|' || p_format || '|' || v_params::text);

  SELECT * INTO v_existing
  FROM public.report_export_jobs
  WHERE dedupe_key = v_dedupe AND status IN ('queued', 'running')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('job_id', v_existing.id, 'status', v_existing.status, 'deduplicated', true);
  END IF;

  INSERT INTO public.report_export_jobs (
    organization_id, requested_by, report_type, format, parameters,
    config_snapshot, dedupe_key, status
  ) VALUES (
    p_organization_id, auth.uid(), p_report_type, p_format, v_params,
    '{}'::jsonb, v_dedupe, 'queued'
  )
  RETURNING id INTO v_job_id;

  RETURN jsonb_build_object('job_id', v_job_id, 'status', 'queued', 'deduplicated', false);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Grants. Row producers are worker-only; enqueue is caller-facing.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.report_expense_rows_v1(uuid, text[], text, uuid[], date, date, text, jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_expense_rows_v1(uuid, text[], text, uuid[], date, date, text, jsonb, integer, boolean) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.report_expense_rows_v1(uuid, text[], text, uuid[], date, date, text, jsonb, integer, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.report_expense_allocations_v1(uuid, uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_expense_allocations_v1(uuid, uuid, date, date) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.report_expense_allocations_v1(uuid, uuid, date, date) TO service_role;

REVOKE ALL ON FUNCTION public._report_expense_custom_fields_v1(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._report_expense_custom_fields_v1(uuid, uuid[]) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._report_expense_custom_fields_v1(uuid, uuid[]) TO service_role;

GRANT EXECUTE ON FUNCTION public.create_expense_report_export_job_v1(uuid, text, jsonb, boolean, text) TO authenticated;

COMMIT;
