-- Daily Project Report (SERVER-SIDE WORKER path) -- carry each expense's own
-- "Remark" through so the exported CSV's Remarks column can be populated.
--
-- ============================================================================
-- STATUS: authored for peso-bckup only. NOT applied to Production.
-- Additive: CREATE OR REPLACE on report_daily_project_rows_v1, same signature.
-- ============================================================================
--
-- WHY A SECOND MIGRATION FOR THE SAME FEATURE
--
-- 20260827100000 fixed get_daily_project_report_page_v1 -- the RPC the BROWSER
-- calls. It turns out the downloaded CSV is not built by the browser at all:
-- since DOC-104/105 the file is produced by the Deno worker in
-- supabase/functions/run-report-export-job/, which calls a DIFFERENT function,
-- report_daily_project_rows_v1, and re-implements the row shaping itself.
-- So the Remarks column stayed blank in the actual download even though the
-- browser-side path was already correct and verified.
--
-- Two changes, both minimal:
--   1. `enriched` now carries f.purpose forward (it selects an explicit column
--      list, so purpose was being dropped there even though `filtered` had it).
--      `resolved` selects en.*, so it propagates from there automatically.
--   2. source_expenses' jsonb_build_object gains 'purpose', matching what
--      get_daily_project_report_page_v1 already emits, so both paths hand the
--      same shape to their respective row builders.
--
-- Everything else is byte-identical to the live definition this was generated
-- from (pg_get_functiondef on the backup database), so no other behaviour --
-- grouping, project-name fallback chain, cursoring, totals -- changes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.report_daily_project_rows_v1(p_organization_id uuid, p_config jsonb, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_user_id uuid DEFAULT NULL::uuid, p_user_ids uuid[] DEFAULT NULL::uuid[], p_snapshot_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor jsonb DEFAULT NULL::jsonb, p_page_size integer DEFAULT 250, p_with_total boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

NOTIFY pgrst, 'reload schema';
