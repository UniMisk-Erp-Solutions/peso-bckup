-- Server-side report generation -- Remarks + batch ambiguity redesign.
--
-- ============================================================================
-- WHY THIS FILE EXISTS
-- ============================================================================
-- The prior design (20260827160000_daily_project_report_shared_core.sql)
-- computed `project_name_ambiguous` inside `report_daily_project_rows_v1`
-- itself, via a whole-population `ambiguity` CTE scanning every approved
-- expense in the organization on every single page/call. That version was
-- twice applied to and rolled back from Production:
--
--   1. First attempt (2026-08-29, AMENDED 2026-08-27 in that file's own
--      history): caused a query that normally completes in seconds to hang
--      for 2+ minutes against MicroLink's real ~12.6k-row dataset. Emergency
--      rollback via pg_cancel_backend + function restore.
--   2. Second attempt, after root-causing a real `plan_cache_mode=auto`
--      double-execution bug and fixing it with a function-scoped
--      `set_config('plan_cache_mode','force_custom_plan',true)`: validated
--      in an isolated throwaway-database copy at ~0.85-1.4s per call, but on
--      real Production the same fixed function measured a consistent
--      ~10.5-11.3s across three back-to-back real RPC calls -- an isolated,
--      idle throwaway database is not a representative proxy for a query
--      whose performance depends on Production's shared, constantly-churned
--      buffer cache. Rolled back again.
--
-- Both incidents trace to the same root architectural problem: computing
-- ambiguity for a report PAGE requires touching the WHOLE organization's
-- approved-expense population once per call, regardless of how the query is
-- tuned. No amount of plan-cache or server-setting tuning fixes an
-- architecture that scans ~12,600+ rows through 4 LATERAL joins to answer a
-- question about the 250 rows on one page.
--
-- THE FIX IS ARCHITECTURAL, NOT A QUERY OPTIMIZATION:
--
-- 1. `report_daily_project_rows_v1` is restored to the exact base
--    architecture already proven safe and fast in real Production use
--    (the same function that was live before Step 2 was ever attempted),
--    with exactly one addition: `f.purpose` is now carried through to
--    `source_expenses[].purpose` (the Remarks feature). This is a single
--    already-selected column added to an existing SELECT list and an
--    existing jsonb_build_object -- no new join, no new CTE, no new scan.
--
-- 2. Ambiguity moves to its own new, narrowly-scoped, indexed RPC,
--    `get_daily_report_project_name_ambiguity_batch_v2`, which answers the
--    question "which of THESE SPECIFIC project IDs are ambiguous" using the
--    `effv_rq2_template_filter_idx` / `effv_rq2_branch_filter_idx` composite
--    indexes on (organization_id, template_id|branch_field_id, field_value,
--    expense_id) -- i.e. it looks up exactly the rows matching the supplied
--    project IDs directly via an index, and never scans the organization's
--    full approved-expense population. Callers (the foreground report page
--    and the export worker) are responsible for calling this with only the
--    project IDs present on the page/rows they already have in hand -- see
--    src/lib/dailyProjectReportPaging.ts and
--    supabase/functions/run-report-export-job/index.ts for the merge logic.
--
-- The whole-population ambiguity CTE from the abandoned design is not
-- reproduced anywhere in this file. It was never left live on Production
-- (both attempts were rolled back before this migration was written).
-- ============================================================================


-- ── 1. report_daily_project_rows_v1: restored to the proven base plus the
--       cheap Remarks passthrough only. No ambiguity computation here. ──────
CREATE OR REPLACE FUNCTION public.report_daily_project_rows_v1(
  p_organization_id uuid,
  p_config          jsonb,
  p_date_from       date        DEFAULT NULL,
  p_date_to         date        DEFAULT NULL,
  p_user_id         uuid        DEFAULT NULL,
  p_user_ids        uuid[]      DEFAULT NULL,
  p_snapshot_at     timestamptz DEFAULT NULL,
  p_cursor          jsonb       DEFAULT NULL,
  p_page_size       integer     DEFAULT 250,
  p_with_total      boolean     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_size      integer     := LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 2000);
  v_snapshot  timestamptz := COALESCE(p_snapshot_at, now());
  v_cfg       jsonb       := COALESCE(p_config, '{}'::jsonb);
  v_cat_map   jsonb;
  v_pid_kind  text; v_pid_key text; v_pid_uuid uuid;
  v_pnm_kind  text; v_pnm_key text; v_pnm_uuid uuid;
  v_loc_kind  text; v_loc_key text; v_loc_uuid uuid;
  v_cur_date  text := NULL;
  v_cur_user  uuid := NULL;
  v_cur_proj  text := NULL;
  v_total_req boolean := COALESCE(p_with_total, p_cursor IS NULL);
  v_out       jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
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

  WITH catmap AS (
    -- Flatten categoryMappings ONCE. First cost column wins on a duplicate
    -- category, exactly as resolveCategoryToCostColumn's ordered scan does.
    SELECT DISTINCT ON (lower(btrim(c.v)))
           lower(btrim(c.v)) AS cat_lower, t.kk AS cost_column
    FROM unnest(ARRAY['petrol_cost','material_cost','travelling_cost','phone_exp',
                      'hotel_exp','transport_exp','contra_bill','other_exp'])
         WITH ORDINALITY AS t(kk, ord)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(v_cat_map -> t.kk) = 'array' THEN v_cat_map -> t.kk
           ELSE '[]'::jsonb END) AS c(v)
    WHERE btrim(c.v) <> ''
    ORDER BY lower(btrim(c.v)), t.ord
  ),
  filtered AS (
    SELECT e.id, e.user_id, e.trip_start, e.category, e.total_amount,
           e.title, e.destination, e.purpose, e.transaction_number, e.organization_id
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
    SELECT f.id, f.user_id, f.trip_start, f.category, f.total_amount, f.title,
           f.transaction_number, f.purpose,
           COALESCE(CASE v_pid_kind
             WHEN 'base' THEN public._daily_report_base_value_v1(v_pid_key, f.title, f.destination, f.purpose, f.category, f.trip_start, f.total_amount)
             WHEN 'template' THEN btrim(COALESCE(fv_pid.field_value, ''))
             WHEN 'branch'   THEN btrim(COALESCE(fv_pid.field_value, ''))
             ELSE '' END, '') AS project_id,
           COALESCE(CASE v_pnm_kind
             WHEN 'base' THEN public._daily_report_base_value_v1(v_pnm_key, f.title, f.destination, f.purpose, f.category, f.trip_start, f.total_amount)
             WHEN 'template' THEN btrim(COALESCE(fv_pnm.field_value, ''))
             WHEN 'branch'   THEN btrim(COALESCE(fv_pnm.field_value, ''))
             ELSE '' END, '') AS project_name_configured,
           btrim(COALESCE(fv_pnm_branch.field_value, '')) AS project_name_branch,
           COALESCE(CASE v_loc_kind
             WHEN 'base' THEN public._daily_report_base_value_v1(v_loc_key, f.title, f.destination, f.purpose, f.category, f.trip_start, f.total_amount)
             WHEN 'template' THEN btrim(COALESCE(fv_loc.field_value, ''))
             WHEN 'branch'   THEN btrim(COALESCE(fv_loc.field_value, ''))
             ELSE '' END, '') AS location,
           COALESCE(f.trip_start::text, '') AS track_date_key,
           COALESCE(cm.cost_column, 'other_exp') AS cost_column,
           COALESCE(NULLIF(btrim(COALESCE(f.transaction_number, '')), ''),
                    NULLIF(btrim(COALESCE(f.title, '')), ''), '') AS voucher_candidate
    FROM filtered f
    LEFT JOIN catmap cm ON cm.cat_lower = lower(btrim(COALESCE(f.category, '')))
    LEFT JOIN LATERAL (
      SELECT v.field_value FROM public.expense_form_field_values v
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND ((v_pid_kind = 'template' AND v.template_id     = v_pid_uuid)
          OR (v_pid_kind = 'branch'   AND v.branch_field_id = v_pid_uuid))
      LIMIT 1) fv_pid ON v_pid_kind IN ('template', 'branch')
    LEFT JOIN LATERAL (
      SELECT v.field_value FROM public.expense_form_field_values v
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND ((v_pnm_kind = 'template' AND v.template_id     = v_pnm_uuid)
          OR (v_pnm_kind = 'branch'   AND v.branch_field_id = v_pnm_uuid))
      LIMIT 1) fv_pnm ON v_pnm_kind IN ('template', 'branch')
    LEFT JOIN LATERAL (
      SELECT v.field_value FROM public.expense_form_field_values v
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND ((v_loc_kind = 'template' AND v.template_id     = v_loc_uuid)
          OR (v_loc_kind = 'branch'   AND v.branch_field_id = v_loc_uuid))
      LIMIT 1) fv_loc ON v_loc_kind IN ('template', 'branch')
    -- The nested sub-option actually submitted against this expense.
    LEFT JOIN LATERAL (
      SELECT v.field_value
      FROM public.expense_form_field_values v
      JOIN public.expense_form_field_option_branches b ON b.id = v.branch_field_id
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND b.field_key = 'project_name'
      ORDER BY b.display_order, b.id
      LIMIT 1) fv_pnm_branch ON true
  ),
  resolved AS (
    SELECT en.*,
           COALESCE(NULLIF(en.project_name_configured, ''),
                    NULLIF(en.project_name_branch, ''),
                    NULLIF(btrim(COALESCE(defn.def_name, '')), ''),
                    '') AS project_name
    FROM enriched en
    -- Last resort: the branch DEFINITION for this expense's project id.
    LEFT JOIN LATERAL (
      SELECT btrim(b.options ->> 0) AS def_name
      FROM public.expense_form_field_option_branches b
      WHERE b.organization_id = p_organization_id
        AND b.field_key = 'project_name'
        AND b.parent_option_value = en.project_id
        AND jsonb_array_length(COALESCE(b.options, '[]'::jsonb)) = 1
      ORDER BY b.retired_at NULLS FIRST, b.display_order, b.id
      LIMIT 1) defn
      ON btrim(COALESCE(en.project_name_configured, '')) = ''
     AND btrim(COALESCE(en.project_name_branch, '')) = ''
     AND btrim(COALESCE(en.project_id, '')) <> ''
  ),
  grouped AS (
    SELECT g.track_date_key, g.user_id, btrim(g.project_id) AS project_id_key,
           (array_remove(array_agg(NULLIF(g.project_name, '')     ORDER BY g.trip_start, g.id), NULL))[1] AS project_name,
           (array_remove(array_agg(NULLIF(g.location, '')         ORDER BY g.trip_start, g.id), NULL))[1] AS location,
           (array_remove(array_agg(NULLIF(g.voucher_candidate, '')ORDER BY g.trip_start, g.id), NULL))[1] AS voucher_no,
           sum(COALESCE(g.total_amount,0)) FILTER (WHERE g.cost_column='petrol_cost')     AS petrol_cost,
           sum(COALESCE(g.total_amount,0)) FILTER (WHERE g.cost_column='material_cost')   AS material_cost,
           sum(COALESCE(g.total_amount,0)) FILTER (WHERE g.cost_column='travelling_cost') AS travelling_cost,
           sum(COALESCE(g.total_amount,0)) FILTER (WHERE g.cost_column='phone_exp')       AS phone_exp,
           sum(COALESCE(g.total_amount,0)) FILTER (WHERE g.cost_column='hotel_exp')       AS hotel_exp,
           sum(COALESCE(g.total_amount,0)) FILTER (WHERE g.cost_column='transport_exp')   AS transport_exp,
           sum(COALESCE(g.total_amount,0)) FILTER (WHERE g.cost_column='contra_bill')     AS contra_bill,
           sum(COALESCE(g.total_amount,0)) FILTER (WHERE g.cost_column='other_exp')       AS other_exp,
           count(*) AS source_count,
           sum(COALESCE(g.total_amount,0)) AS source_amount,
           jsonb_agg(jsonb_build_object(
             'id', g.id, 'category', g.category, 'total_amount', COALESCE(g.total_amount,0),
             'trip_start', g.trip_start, 'title', g.title,
             'transaction_number', g.transaction_number,
             'voucher_no', g.voucher_candidate, 'cost_column', g.cost_column,
             'purpose', g.purpose
           ) ORDER BY g.trip_start, g.category, g.id) AS source_expenses
    FROM resolved g
    GROUP BY g.track_date_key, g.user_id, btrim(g.project_id)
  ),
  denom AS (
    SELECT track_date_key, user_id, count(*)::int AS projects_in_employee_day
    FROM grouped GROUP BY track_date_key, user_id
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
             'track_date', r.track_date_key, 'user_id', r.user_id,
             'project_id', r.project_id_key,
             'project_name', COALESCE(r.project_name, ''),
             'location', COALESCE(r.location, ''),
             'voucher_no', COALESCE(r.voucher_no, ''),
             'employee_name', COALESCE(i.name, ''),
             'employee_code', COALESCE(i.employee_id, ''),
             'projects_in_employee_day', r.projects_in_employee_day,
             'costs', jsonb_build_object(
               'petrol_cost', r.petrol_cost, 'material_cost', r.material_cost,
               'travelling_cost', r.travelling_cost, 'phone_exp', r.phone_exp,
               'hotel_exp', r.hotel_exp, 'transport_exp', r.transport_exp,
               'contra_bill', r.contra_bill, 'other_exp', r.other_exp),
             'source_expenses', r.source_expenses
           ) ORDER BY r.track_date_key, r.user_id, r.project_id_key) AS arr,
           count(*) AS n,
           COALESCE(sum(r.source_count), 0) AS page_source_count,
           COALESCE(sum(r.source_amount), 0) AS page_source_amount
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
    -- Whole-population totals: the numbers every completeness gate asserts on.
    SELECT CASE WHEN v_total_req THEN (SELECT count(*) FROM grouped) END        AS total,
           CASE WHEN v_total_req THEN (SELECT count(*) FROM filtered) END       AS src_count,
           CASE WHEN v_total_req THEN (SELECT COALESCE(sum(COALESCE(total_amount,0)),0) FROM filtered) END AS src_amount
  )
  SELECT jsonb_build_object(
    'schema_version',     1,
    'snapshot_at',        v_snapshot,
    'page_size',          v_size,
    'total_count',        (SELECT total FROM tot),
    'source_count',       (SELECT src_count FROM tot),
    'source_amount',      (SELECT src_amount FROM tot),
    'page_source_count',  COALESCE((SELECT page_source_count FROM items), 0),
    'page_source_amount', COALESCE((SELECT page_source_amount FROM items), 0),
    'returned',           COALESCE((SELECT n FROM items), 0),
    'has_more',           COALESCE((SELECT n FROM items), 0) = v_size,
    'next_cursor',        CASE WHEN COALESCE((SELECT n FROM items), 0) = v_size
                               THEN (SELECT jsonb_build_object(
                                       'track_date', lr.track_date_key,
                                       'user_id',    lr.user_id,
                                       'project_id', lr.project_id_key)
                                     FROM last_row lr)
                               ELSE NULL END,
    'rows',               COALESCE((SELECT arr FROM items), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.report_daily_project_rows_v1(uuid, jsonb, date, date, uuid, uuid[], timestamptz, jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_daily_project_rows_v1(uuid, jsonb, date, date, uuid, uuid[], timestamptz, jsonb, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.report_daily_project_rows_v1(uuid, jsonb, date, date, uuid, uuid[], timestamptz, jsonb, integer, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.report_daily_project_rows_v1(uuid, jsonb, date, date, uuid, uuid[], timestamptz, jsonb, integer, boolean) TO service_role;

COMMENT ON FUNCTION public.report_daily_project_rows_v1(uuid, jsonb, date, date, uuid, uuid[], timestamptz, jsonb, integer, boolean) IS
  'THE Daily Project Report computation (base architecture, plus Remarks '
  'passthrough only). Ambiguity is intentionally NOT computed here -- see '
  'get_daily_report_project_name_ambiguity_batch_v2 and '
  '20260829120000_daily_report_remarks_and_batch_ambiguity.sql for why. '
  'Performs NO authorization: service_role only. The authenticated entry '
  'point is get_daily_project_report_page_v1.';


-- ── The authenticated wrapper -- signature and behavior unchanged ───────────
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
  v_cfg jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, COALESCE(p_team_scoped, false)) THEN
    RAISE EXCEPTION 'not permitted to generate this report' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) INTO v_cfg
  FROM public.organization_settings s
  WHERE s.organization_id = p_organization_id;

  RETURN public.report_daily_project_rows_v1(
    p_organization_id, COALESCE(v_cfg, '{}'::jsonb),
    p_date_from, p_date_to, p_user_id, p_user_ids,
    p_snapshot_at, p_cursor, LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 500), NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_project_report_page_v1(uuid, date, date, uuid, uuid[], boolean, timestamptz, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_daily_project_report_page_v1(uuid, date, date, uuid, uuid[], boolean, timestamptz, jsonb, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_daily_project_report_page_v1(uuid, date, date, uuid, uuid[], boolean, timestamptz, jsonb, integer) TO authenticated;


-- ── 2. Batch ambiguity RPC -- answers ambiguity for a SUPPLIED set of ───────
--       project IDs only. Never scans the organization's full population.
--
-- Semantics match the abandoned whole-population implementation exactly: a
-- project ID is ambiguous when 2 or more DISTINCT, non-blank project_name
-- values have actually been SUBMITTED (via the project_name option-branch)
-- by different approved expenses sharing that project id.
--
-- Scope limitation (deliberate): this is only computable via an index when
-- the org's projectId field mapping is 'template' or 'branch' kind (a real,
-- stored field_value the effv_rq2_*_filter_idx indexes cover). For 'base'
-- kind mappings (project id derived from a base expense column, e.g. title),
-- there is no stored, indexable value to look up by -- ambiguity for those
-- project ids is reported as `false` rather than forcing a full-population
-- scan just for that edge case. This matches the original ambiguity RPC
-- design's own reasoning for gating on field-mapping kind (see the removed
-- migration's AMENDED 2026-08-27 note): ambiguity is fundamentally a
-- question about the nested sub-option system, which base-value orgs do not
-- use.
CREATE OR REPLACE FUNCTION public.get_daily_report_project_name_ambiguity_batch_v2(
  p_organization_id uuid,
  p_project_ids     text[]
)
RETURNS TABLE(project_id text, project_name_ambiguous boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg      jsonb;
  v_pid_kind text; v_pid_key text; v_pid_uuid uuid;
  v_ids      text[];
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;

  -- Authorization: authenticated callers must be permitted to view this
  -- org's daily report, same check the foreground page RPC uses. A
  -- service_role caller (the export worker) has no auth.uid() and skips
  -- this -- anon has no grant on this function at all (see REVOKE below),
  -- so a NULL auth.uid() here can only mean a trusted service_role call.
  IF auth.uid() IS NOT NULL AND NOT public.daily_report_caller_can_view_v1(p_organization_id, false) THEN
    RAISE EXCEPTION 'not permitted to view this report' USING ERRCODE = '42501';
  END IF;

  -- Config is resolved here (not accepted as a parameter) so callers never
  -- need to fetch/thread the org's field-mapping config themselves -- the
  -- foreground page and the worker both just pass (organization_id,
  -- project_ids) and get back semantics that always match the report core.
  SELECT s.daily_expense_report_config INTO v_cfg
  FROM public.organization_settings s
  WHERE s.organization_id = p_organization_id;
  v_cfg := COALESCE(v_cfg, '{}'::jsonb);

  v_ids := ARRAY(SELECT DISTINCT btrim(x) FROM unnest(COALESCE(p_project_ids, ARRAY[]::text[])) AS x WHERE btrim(x) <> '');
  IF array_length(v_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  -- Bound the batch: this exists to answer ambiguity for one report page,
  -- never for an arbitrary caller-supplied list approaching org scale.
  IF array_length(v_ids, 1) > 2000 THEN
    RAISE EXCEPTION 'too many project ids requested (max 2000)' USING ERRCODE = '22023';
  END IF;

  SELECT k, v INTO v_pid_kind, v_pid_key
  FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectId}') AS s(k, v);
  v_pid_uuid := CASE WHEN v_pid_kind IN ('template', 'branch') THEN v_pid_key::uuid END;

  IF v_pid_kind NOT IN ('template', 'branch') THEN
    -- 'base' kind (or unmapped): no indexable stored value: return false for
    -- every requested id rather than forcing a full-population scan.
    RETURN QUERY SELECT x, false FROM unnest(v_ids) AS x;
    RETURN;
  END IF;

  RETURN QUERY
  WITH matched AS (
    -- Indexed on (organization_id, template_id, field_value, expense_id) /
    -- (organization_id, branch_field_id, field_value, expense_id) --
    -- touches only rows whose field_value is one of the requested ids, not
    -- the organization's full expense population.
    SELECT v.expense_id, btrim(v.field_value) AS project_id_key
    FROM public.expense_form_field_values v
    JOIN public.expenses e ON e.id = v.expense_id
    WHERE v.organization_id = p_organization_id
      AND e.status = 'approved'
      AND ((v_pid_kind = 'template' AND v.template_id     = v_pid_uuid)
        OR (v_pid_kind = 'branch'   AND v.branch_field_id = v_pid_uuid))
      AND v.field_value = ANY (v_ids)
  ),
  with_branch_name AS (
    -- The nested sub-option actually submitted -- same lookup the report
    -- core uses, but only for the small, already-matched set of expenses.
    SELECT m.project_id_key,
           btrim(COALESCE(fv_pnm_branch.field_value, '')) AS project_name_branch
    FROM matched m
    LEFT JOIN LATERAL (
      SELECT v2.field_value
      FROM public.expense_form_field_values v2
      JOIN public.expense_form_field_option_branches b ON b.id = v2.branch_field_id
      WHERE v2.expense_id = m.expense_id AND v2.organization_id = p_organization_id
        AND b.field_key = 'project_name'
      ORDER BY b.display_order, b.id
      LIMIT 1) fv_pnm_branch ON true
  ),
  agg AS (
    SELECT project_id_key,
           count(DISTINCT NULLIF(project_name_branch, '')) > 1 AS is_ambiguous
    FROM with_branch_name
    GROUP BY project_id_key
  )
  SELECT x, COALESCE(a.is_ambiguous, false)
  FROM unnest(v_ids) AS x
  LEFT JOIN agg a ON a.project_id_key = x;
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_report_project_name_ambiguity_batch_v2(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_daily_report_project_name_ambiguity_batch_v2(uuid, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_daily_report_project_name_ambiguity_batch_v2(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_report_project_name_ambiguity_batch_v2(uuid, text[]) TO service_role;

COMMENT ON FUNCTION public.get_daily_report_project_name_ambiguity_batch_v2(uuid, text[]) IS
  'Read-only, page-scoped ambiguity lookup for the Daily Project Report. '
  'Given a set of already-resolved project ids (from one report page), '
  'returns which are ambiguous -- i.e. two or more distinct, non-blank '
  'project_name sub-option values have been submitted for that id across '
  'approved expenses. Uses effv_rq2_template_filter_idx / '
  'effv_rq2_branch_filter_idx to touch only the requested ids, never the '
  'organization''s full approved-expense population. Callable by '
  'authenticated (own-org, permission-checked) and service_role (worker).';
