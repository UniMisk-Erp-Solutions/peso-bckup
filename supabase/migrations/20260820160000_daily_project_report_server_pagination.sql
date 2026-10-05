-- ############################################################################
-- ## DO NOT RE-APPLY TO peso-bckup AS-IS  (added 2026-09-02, DOC-142)       ##
-- ############################################################################
-- This migration does CREATE OR REPLACE on get_daily_project_report_page_v1
-- using the OLD self-contained implementation.
--
-- Since the 2026-09-01 backup reload, that function on peso-bckup is a THIN
-- WRAPPER that delegates to report_daily_project_rows_v1, so the row-shaping
-- logic exists in exactly one place. Re-running this file would overwrite the
-- wrapper with the old ~250-line copy and reintroduce the two-implementation
-- drift that let the Remarks column ship blank in the CSV (DOC-115).
--
-- Kept for history and because it is still the correct migration for any
-- environment that has NOT had the 2026-09-01 reload (e.g. Production).
-- Before applying anywhere, check first:
--   SELECT pg_get_functiondef(oid) FROM pg_proc
--    WHERE proname = 'get_daily_project_report_page_v1';
-- If that returns a short body calling report_daily_project_rows_v1, SKIP this.
-- ############################################################################

-- DOC-101 — Daily Project Report server-side scalability.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO PRODUCTION.
-- Additive only: three new functions and one new index. No existing function,
-- table, column, RLS policy or grant is modified.
-- ============================================================================
--
-- PROBLEM (measured on Production, read-only, 2026-08-20)
--
-- src/lib/buildDailyProjectExpenseReport.ts fetches the report dataset from the
-- browser with NO `.range()` / `.limit()`:
--
--     supabase.from("expenses")
--       .select("id, user_id, trip_start, category, total_amount, title,
--                destination, purpose, transaction_number")
--       .eq("organization_id", organizationId)
--       .eq("status", "approved")            -- + optional trip_start range
--       .order("trip_start", { ascending: true })
--
-- Two independent, proven failures follow:
--
-- 1. SILENT TRUNCATION. PostgREST injects its own `LIMIT` (db-max-rows) on any
--    unbounded request. pg_stat_statements shows the report's exact query
--    normalised as
--      ... WHERE organization_id = $1 AND status = $2
--          ORDER BY trip_start ASC LIMIT $3 OFFSET $4
--    — a LIMIT the client never asked for. This deployment's cap is 1000,
--    already proven from a HAR capture in DOC-074 (`Content-Range: 0-999/*`).
--    MicroLink currently has 10,111 approved expenses, so the workbook was
--    being generated from at most 1,000 of them (~9.9%) with no error shown.
--
-- 2. TIMEOUT ON CUSTOM-FIELD ENRICHMENT. The same file then loops the expense
--    ids in chunks of 75 and issues one `expense_form_field_values` request per
--    chunk, sequentially. pg_stat_statements for that exact statement:
--        calls              51,386
--        total_exec_time    12,267 s   (~3.4 h of cumulative DB time)
--        mean_exec_time     238.7 ms
--        stddev             602.3 ms
--        max_exec_time      7,984.9 ms
--    The `authenticated` role runs with `statement_timeout = 8s`
--    (pg_roles.rolconfig). A 7,984.9 ms maximum against an 8,000 ms ceiling is
--    the signature of executions being cancelled at the limit — the request
--    that "stops before the dataset is returned".
--
-- WHY THIS FUNCTION
--
-- The same enrichment done set-based, server-side, over the entire MicroLink
-- scope in ONE statement measures 349 ms (EXPLAIN ANALYZE, authenticated role,
-- RLS active) versus 51,386 round trips. Returning a single jsonb document also
-- sidesteps db-max-rows entirely: PostgREST cannot truncate a scalar, and the
-- `rows` array inside stays bounded by p_page_size.
--
-- REPORT SEMANTICS ARE PRESERVED EXACTLY. A Daily Project Report row is NOT an
-- expense — buildDailyProjectExpenseReportRows groups expenses by
-- (trackDate, user_id, projectId). This function reproduces that grouping,
-- the category→cost-column bucketing, the first-non-empty merge for
-- projectName/location/voucherNo, and returns `projects_in_employee_day` so the
-- client keeps using the existing payrollPercentForEmployeeDay(). The final
-- locale-sensitive sort (JS localeCompare) deliberately stays on the client so
-- the produced workbook is byte-comparable with the old implementation.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Category → cost column, mirroring resolveCategoryToCostColumn ─────────
-- dailyExpenseReportConfig.ts: empty/blank category → 'other_exp'; otherwise the
-- FIRST cost column (in DAILY_REPORT_COST_COLUMNS order) whose mapped category
-- list contains a case-insensitive, trimmed match; else 'other_exp'.
CREATE OR REPLACE FUNCTION public.daily_report_cost_column_v1(
  p_category          text,
  p_category_mappings jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN btrim(COALESCE(p_category, '')) = '' THEN 'other_exp'
    ELSE COALESCE(
      (
        SELECT t.k
        FROM unnest(ARRAY[
               'petrol_cost', 'material_cost', 'travelling_cost', 'phone_exp',
               'hotel_exp', 'transport_exp', 'contra_bill', 'other_exp'
             ]) WITH ORDINALITY AS t(k, ord)
        WHERE EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(COALESCE(p_category_mappings, '{}'::jsonb) -> t.k) = 'array'
                      THEN p_category_mappings -> t.k
                      ELSE '[]'::jsonb END
               ) AS c(v)
          WHERE lower(btrim(c.v)) = lower(btrim(p_category))
        )
        ORDER BY t.ord
        LIMIT 1
      ),
      'other_exp'
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.daily_report_cost_column_v1(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.daily_report_cost_column_v1(text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.daily_report_cost_column_v1(text, jsonb) TO authenticated;


-- ── 1b. parseFieldSource() — 'base:<key>' | 'template:<uuid>' | 'branch:<uuid>'
-- | bare uuid (legacy, treated as template). Anything else is unmapped, which
-- renders as an empty column exactly as the client does today.
CREATE OR REPLACE FUNCTION public._daily_report_parse_source_v1(p_raw text)
RETURNS TABLE(kind text, key text)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN v IS NULL OR v = ''            THEN 'none'
           WHEN v LIKE 'base:%'                THEN 'base'
           WHEN v LIKE 'branch:%'              THEN CASE WHEN btrim(substr(v, 8))  = '' THEN 'none' ELSE 'branch'   END
           WHEN v LIKE 'template:%'            THEN CASE WHEN btrim(substr(v, 10)) = '' THEN 'none' ELSE 'template' END
           WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                               THEN 'template'
           ELSE 'none'
         END,
         CASE
           WHEN v IS NULL OR v = ''            THEN NULL
           WHEN v LIKE 'base:%'                THEN substr(v, 6)
           WHEN v LIKE 'branch:%'              THEN NULLIF(btrim(substr(v, 8)),  '')
           WHEN v LIKE 'template:%'            THEN NULLIF(btrim(substr(v, 10)), '')
           WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                               THEN v
           ELSE NULL
         END
  FROM (SELECT btrim(COALESCE(p_raw, '')) AS v) s;
$$;

REVOKE ALL ON FUNCTION public._daily_report_parse_source_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._daily_report_parse_source_v1(text) FROM anon;
GRANT EXECUTE ON FUNCTION public._daily_report_parse_source_v1(text) TO authenticated;


-- ── 1c. resolveMappedFieldValue()'s base-field branch, verbatim ──────────────
-- Unknown keys return '' — the same default the client's switch falls through to.
CREATE OR REPLACE FUNCTION public._daily_report_base_value_v1(
  p_key text, p_title text, p_destination text, p_purpose text,
  p_category text, p_trip_start date, p_total_amount numeric
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_key
    WHEN 'title'        THEN btrim(COALESCE(p_title, ''))
    WHEN 'destination'  THEN btrim(COALESCE(p_destination, ''))
    WHEN 'purpose'      THEN btrim(COALESCE(p_purpose, ''))
    WHEN 'category'     THEN btrim(COALESCE(p_category, ''))
    WHEN 'expense_date' THEN COALESCE(p_trip_start::text, '')
    WHEN 'amount'       THEN CASE WHEN p_total_amount IS NULL THEN ''
                                  ELSE trim(to_char(p_total_amount, 'FM9999999999990.999999')) END
    ELSE ''
  END;
$$;

REVOKE ALL ON FUNCTION public._daily_report_base_value_v1(text, text, text, text, text, date, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._daily_report_base_value_v1(text, text, text, text, text, date, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public._daily_report_base_value_v1(text, text, text, text, text, date, numeric) TO authenticated;


-- ── 2. Who may generate this report — server-authoritative ───────────────────
-- Mirrors the client rule that today lives only in the browser
-- (useCashierCapabilities.canAccessReports / TEAM_REPORTS_LEADER_ROLES):
--   org-wide  : admin, or an accountant-cashier while cashier_accountant_mode is on
--   team-scope: admin / engineer / team_leader / executive
-- Membership must be active in THIS organization. Never trusts a client role.
CREATE OR REPLACE FUNCTION public.daily_report_caller_can_view_v1(
  p_organization_id uuid,
  p_team_scoped     boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT CASE
        WHEN p_team_scoped THEN
          m.role::text IN ('admin', 'engineer', 'team_leader', 'executive')
        ELSE
          m.role::text = 'admin'
          OR (
            COALESCE(m.is_accountant_cashier, false)
            AND EXISTS (
              SELECT 1 FROM public.organization_features f
              WHERE f.organization_id = p_organization_id
                AND f.feature_key = 'cashier_accountant_mode'
                AND f.enabled = true
            )
          )
      END
      FROM public.organization_memberships m
      WHERE m.user_id = auth.uid()
        AND m.organization_id = p_organization_id
        AND m.is_active = true
      LIMIT 1
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.daily_report_caller_can_view_v1(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.daily_report_caller_can_view_v1(uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.daily_report_caller_can_view_v1(uuid, boolean) TO authenticated;


-- ── 3. The paged report contract ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_daily_project_report_page_v1(
  p_organization_id uuid,
  p_date_from       date        DEFAULT NULL,
  p_date_to         date        DEFAULT NULL,
  p_user_id         uuid        DEFAULT NULL,
  p_user_ids        uuid[]      DEFAULT NULL,
  p_team_scoped     boolean     DEFAULT false,
  p_snapshot_at     timestamptz DEFAULT NULL,
  p_cursor          jsonb       DEFAULT NULL,
  p_page_size       integer     DEFAULT 250
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_size        integer     := LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 500);
  v_snapshot    timestamptz := COALESCE(p_snapshot_at, now());
  v_cfg         jsonb;
  v_cat_map     jsonb;
  v_pid_kind    text; v_pid_key text; v_pid_uuid uuid;
  v_pnm_kind    text; v_pnm_key text; v_pnm_uuid uuid;
  v_loc_kind    text; v_loc_key text; v_loc_uuid uuid;
  v_cur_date    text := NULL;
  v_cur_user    uuid := NULL;
  v_cur_proj    text := NULL;
  v_out         jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;

  -- Tenant scope + report permission are BOTH resolved server-side from
  -- auth.uid(). p_organization_id is validated, never trusted.
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, COALESCE(p_team_scoped, false)) THEN
    RAISE EXCEPTION 'not permitted to generate this report' USING ERRCODE = '42501';
  END IF;

  IF p_cursor IS NOT NULL AND jsonb_typeof(p_cursor) <> 'object' THEN
    RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
  END IF;

  IF p_cursor IS NOT NULL THEN
    v_cur_date := p_cursor ->> 'track_date';
    v_cur_user := NULLIF(p_cursor ->> 'user_id', '')::uuid;
    v_cur_proj := p_cursor ->> 'project_id';
    IF v_cur_date IS NULL OR v_cur_user IS NULL OR v_cur_proj IS NULL THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Mapping config is read from the database, never accepted from the browser.
  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb)
    INTO v_cfg
  FROM public.organization_settings s
  WHERE s.organization_id = p_organization_id;

  v_cfg     := COALESCE(v_cfg, '{}'::jsonb);
  v_cat_map := CASE WHEN jsonb_typeof(v_cfg -> 'categoryMappings') = 'object'
                    THEN v_cfg -> 'categoryMappings' ELSE '{}'::jsonb END;

  SELECT k, v INTO v_pid_kind, v_pid_key
  FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectId}') AS s(k, v);
  SELECT k, v INTO v_pnm_kind, v_pnm_key
  FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectName}') AS s(k, v);
  SELECT k, v INTO v_loc_kind, v_loc_key
  FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,location}') AS s(k, v);

  v_pid_uuid := CASE WHEN v_pid_kind IN ('template', 'branch') THEN v_pid_key::uuid END;
  v_pnm_uuid := CASE WHEN v_pnm_kind IN ('template', 'branch') THEN v_pnm_key::uuid END;
  v_loc_uuid := CASE WHEN v_loc_kind IN ('template', 'branch') THEN v_loc_key::uuid END;

  -- ── scope → enrich → group → paginate ──────────────────────────────────────
  WITH filtered AS (
    -- authorized_scope + filtered_base + stable_snapshot.
    -- Snapshot anchors on created_at (immutable) so that editing an expense
    -- mid-export does NOT silently remove it from the population; only an
    -- approve/unapprove during the export can change the set, and the client's
    -- total_count assertion catches that and refuses to write a file.
    SELECT e.id, e.user_id, e.trip_start, e.category, e.total_amount,
           e.title, e.destination, e.purpose, e.transaction_number,
           e.organization_id
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status = 'approved'
      AND e.created_at <= v_snapshot
      AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
      AND (p_date_to   IS NULL OR e.trip_start <= p_date_to)
      AND (p_user_id   IS NULL OR e.user_id = p_user_id)
      AND (p_user_ids  IS NULL OR e.user_id = ANY (p_user_ids))
  ),
  enriched AS (
    -- Set-based enrichment: ONE join per mapped field for the whole scope,
    -- replacing the browser's 75-id chunk loop. LATERAL ... LIMIT 1 mirrors the
    -- client dictionary (one value per expense per field id) and prevents row
    -- multiplication when a field id appears more than once for an expense.
    SELECT f.*,
           COALESCE(
             CASE v_pid_kind
               WHEN 'base'     THEN public._daily_report_base_value_v1(v_pid_key, f.title, f.destination, f.purpose, f.category, f.trip_start, f.total_amount)
               WHEN 'template' THEN btrim(COALESCE(fv_pid.field_value, ''))
               WHEN 'branch'   THEN btrim(COALESCE(fv_pid.field_value, ''))
               ELSE '' END, '') AS project_id,
           COALESCE(
             CASE v_pnm_kind
               WHEN 'base'     THEN public._daily_report_base_value_v1(v_pnm_key, f.title, f.destination, f.purpose, f.category, f.trip_start, f.total_amount)
               WHEN 'template' THEN btrim(COALESCE(fv_pnm.field_value, ''))
               WHEN 'branch'   THEN btrim(COALESCE(fv_pnm.field_value, ''))
               ELSE '' END, '') AS project_name,
           COALESCE(
             CASE v_loc_kind
               WHEN 'base'     THEN public._daily_report_base_value_v1(v_loc_key, f.title, f.destination, f.purpose, f.category, f.trip_start, f.total_amount)
               WHEN 'template' THEN btrim(COALESCE(fv_loc.field_value, ''))
               WHEN 'branch'   THEN btrim(COALESCE(fv_loc.field_value, ''))
               ELSE '' END, '') AS location,
           COALESCE(f.trip_start::text, '')                  AS track_date_key,
           public.daily_report_cost_column_v1(f.category, v_cat_map) AS cost_column,
           COALESCE(NULLIF(btrim(COALESCE(f.transaction_number, '')), ''),
                    NULLIF(btrim(COALESCE(f.title, '')), ''), '')    AS voucher_candidate
    FROM filtered f
    LEFT JOIN LATERAL (
      SELECT v.field_value FROM public.expense_form_field_values v
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND ((v_pid_kind = 'template' AND v.template_id     = v_pid_uuid)
          OR (v_pid_kind = 'branch'   AND v.branch_field_id = v_pid_uuid))
      LIMIT 1
    ) fv_pid ON v_pid_kind IN ('template', 'branch')
    LEFT JOIN LATERAL (
      SELECT v.field_value FROM public.expense_form_field_values v
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND ((v_pnm_kind = 'template' AND v.template_id     = v_pnm_uuid)
          OR (v_pnm_kind = 'branch'   AND v.branch_field_id = v_pnm_uuid))
      LIMIT 1
    ) fv_pnm ON v_pnm_kind IN ('template', 'branch')
    LEFT JOIN LATERAL (
      SELECT v.field_value FROM public.expense_form_field_values v
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND ((v_loc_kind = 'template' AND v.template_id     = v_loc_uuid)
          OR (v_loc_kind = 'branch'   AND v.branch_field_id = v_loc_uuid))
      LIMIT 1
    ) fv_loc ON v_loc_kind IN ('template', 'branch')
  ),
  grouped AS (
    -- The report's real row identity: (trackDate, user_id, projectId).
    -- projectName / location / voucherNo take the FIRST non-empty value in a
    -- deterministic (trip_start, id) order — mergeTextField / resolveVoucherNo.
    SELECT g.track_date_key,
           g.user_id,
           btrim(g.project_id) AS project_id_key,
           (array_remove(array_agg(NULLIF(g.project_name, '') ORDER BY g.trip_start, g.id), NULL))[1] AS project_name,
           (array_remove(array_agg(NULLIF(g.location,     '') ORDER BY g.trip_start, g.id), NULL))[1] AS location,
           (array_remove(array_agg(NULLIF(g.voucher_candidate, '') ORDER BY g.trip_start, g.id), NULL))[1] AS voucher_no,
           sum(COALESCE(g.total_amount, 0)) FILTER (WHERE g.cost_column = 'petrol_cost')     AS petrol_cost,
           sum(COALESCE(g.total_amount, 0)) FILTER (WHERE g.cost_column = 'material_cost')   AS material_cost,
           sum(COALESCE(g.total_amount, 0)) FILTER (WHERE g.cost_column = 'travelling_cost') AS travelling_cost,
           sum(COALESCE(g.total_amount, 0)) FILTER (WHERE g.cost_column = 'phone_exp')       AS phone_exp,
           sum(COALESCE(g.total_amount, 0)) FILTER (WHERE g.cost_column = 'hotel_exp')       AS hotel_exp,
           sum(COALESCE(g.total_amount, 0)) FILTER (WHERE g.cost_column = 'transport_exp')   AS transport_exp,
           sum(COALESCE(g.total_amount, 0)) FILTER (WHERE g.cost_column = 'contra_bill')     AS contra_bill,
           sum(COALESCE(g.total_amount, 0)) FILTER (WHERE g.cost_column = 'other_exp')       AS other_exp,
           jsonb_agg(jsonb_build_object(
             'id',                 g.id,
             'category',           g.category,
             'total_amount',       COALESCE(g.total_amount, 0),
             'trip_start',         g.trip_start,
             'title',              g.title,
             'transaction_number', g.transaction_number,
             'voucher_no',         g.voucher_candidate,
             'cost_column',        g.cost_column
           ) ORDER BY g.trip_start, g.category, g.id) AS source_expenses
    FROM enriched g
    GROUP BY g.track_date_key, g.user_id, btrim(g.project_id)
  ),
  denom AS (
    -- payrollPercentForEmployeeDay's denominator: distinct project rows for that
    -- (trackDate, employee) across the WHOLE snapshot — never per page.
    SELECT track_date_key, user_id, count(*)::int AS projects_in_employee_day
    FROM grouped
    GROUP BY track_date_key, user_id
  ),
  page_rows AS (
    SELECT gr.*, d.projects_in_employee_day
    FROM grouped gr
    JOIN denom d ON d.track_date_key = gr.track_date_key AND d.user_id = gr.user_id
    WHERE p_cursor IS NULL
       OR (gr.track_date_key, gr.user_id, gr.project_id_key) > (v_cur_date, v_cur_user, v_cur_proj)
    ORDER BY gr.track_date_key, gr.user_id, gr.project_id_key
    LIMIT v_size
  ),
  ident AS (
    SELECT p.user_id,
           COALESCE(NULLIF(btrim(COALESCE(pr.name, '')), ''), '')        AS name,
           COALESCE(NULLIF(btrim(COALESCE(pr.employee_id, '')), ''), '') AS employee_id
    FROM (SELECT DISTINCT user_id FROM page_rows) p
    LEFT JOIN public.profiles pr
           ON pr.user_id = p.user_id AND pr.organization_id = p_organization_id
  ),
  items AS (
    SELECT jsonb_agg(jsonb_build_object(
             'track_date',               r.track_date_key,
             'user_id',                  r.user_id,
             'project_id',               r.project_id_key,
             'project_name',             COALESCE(r.project_name, ''),
             'location',                 COALESCE(r.location, ''),
             'voucher_no',               COALESCE(r.voucher_no, ''),
             'employee_name',            COALESCE(i.name, ''),
             'employee_code',            COALESCE(i.employee_id, ''),
             'projects_in_employee_day', r.projects_in_employee_day,
             'costs', jsonb_build_object(
               'petrol_cost',     r.petrol_cost,     'material_cost', r.material_cost,
               'travelling_cost', r.travelling_cost, 'phone_exp',     r.phone_exp,
               'hotel_exp',       r.hotel_exp,       'transport_exp', r.transport_exp,
               'contra_bill',     r.contra_bill,     'other_exp',     r.other_exp
             ),
             'source_expenses', r.source_expenses
           ) ORDER BY r.track_date_key, r.user_id, r.project_id_key) AS arr,
           count(*) AS n
    FROM page_rows r
    LEFT JOIN ident i ON i.user_id = r.user_id
  ),
  last_row AS (
    SELECT r.track_date_key, r.user_id, r.project_id_key
    FROM page_rows r
    ORDER BY r.track_date_key DESC, r.user_id DESC, r.project_id_key DESC
    LIMIT 1
  ),
  tot AS (
    -- Authoritative population size. Computed only for the FIRST page: the
    -- client captures it once and asserts against it before writing a file.
    SELECT CASE WHEN p_cursor IS NULL THEN (SELECT count(*) FROM grouped) END AS total
  )
  SELECT jsonb_build_object(
    'schema_version', 1,
    'snapshot_at',    v_snapshot,
    'page_size',      v_size,
    'total_count',    (SELECT total FROM tot),
    'returned',       COALESCE((SELECT n FROM items), 0),
    'has_more',       COALESCE((SELECT n FROM items), 0) = v_size,
    'next_cursor',    CASE WHEN COALESCE((SELECT n FROM items), 0) = v_size
                           THEN (SELECT jsonb_build_object(
                                   'track_date', lr.track_date_key,
                                   'user_id',    lr.user_id,
                                   'project_id', lr.project_id_key)
                                 FROM last_row lr)
                           ELSE NULL END,
    'rows',           COALESCE((SELECT arr FROM items), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_project_report_page_v1(uuid, date, date, uuid, uuid[], boolean, timestamptz, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_daily_project_report_page_v1(uuid, date, date, uuid, uuid[], boolean, timestamptz, jsonb, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_daily_project_report_page_v1(uuid, date, date, uuid, uuid[], boolean, timestamptz, jsonb, integer) TO authenticated;

COMMENT ON FUNCTION public.get_daily_project_report_page_v1(uuid, date, date, uuid, uuid[], boolean, timestamptz, jsonb, integer) IS
  'DOC-101. One bounded page of Daily Project Report rows as a single jsonb '
  'envelope (never a PostgREST rowset, so db-max-rows cannot truncate it). '
  'Resolves tenant scope, report permission, filters, custom-field enrichment '
  'and the (trackDate, user_id, projectId) grouping server-side; returns '
  'projects_in_employee_day so the client keeps its existing percent and '
  'locale-sensitive sort, preserving the current workbook exactly.';


-- ── 4. Index ─────────────────────────────────────────────────────────────────
-- Justified by EXPLAIN, not added speculatively. The report scan is
--   WHERE organization_id = $1 AND status = 'approved' [AND trip_start BETWEEN]
--   ORDER BY trip_start
-- Production plan BEFORE this index (authenticated role, RLS active, MicroLink):
--   Seq Scan on expenses (actual 0.154..17.645 rows=10111) Rows Removed: 7896
--     -> Sort (actual 33.033..45.390) Execution Time: 56.795 ms
-- No existing index covers (organization_id, status, trip_start): the five
-- expenses_rq2_* indexes are all keyed on COALESCE(updated_at, created_at) or
-- on assigned_*_id, none of which serve this predicate or this ordering.
-- The keyset page also probes (track_date_key = trip_start, user_id), which this
-- index orders directly, so later pages can start mid-index instead of
-- re-scanning the whole table.
-- Trade-off: one extra btree on a table with ~18k rows and a write pattern of a
-- few hundred inserts/updates per day — negligible write cost, and it is a
-- partial index so it only carries approved rows (10,111 of 18,007 today).
CREATE INDEX IF NOT EXISTS expenses_daily_report_scope_idx
  ON public.expenses (organization_id, trip_start, user_id)
  WHERE status = 'approved';
