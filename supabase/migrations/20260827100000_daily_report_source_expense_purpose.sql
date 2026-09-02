-- ############################################################################
-- ## DO NOT RE-APPLY TO peso-bckup AS-IS  (added 2026-09-02, DOC-116)       ##
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

-- Daily Project Report — widen source_expenses to carry each expense's
-- own "Remark" (base field `purpose`, commonly relabeled per-org — see
-- src/lib/expenseFormConfig.ts DEFAULT_BASE_FIELD_CONFIG.purpose), so the
-- "Remarks" column can finally be populated.
--
-- ============================================================================
-- STATUS: authored for peso-bckup only. NOT applied to Production.
-- Additive: CREATE OR REPLACE on the one function that needs it
-- (get_daily_project_report_page_v1, from
-- 20260826100000_daily_report_dynamic_project_name.sql). Same signature, so
-- the deployed frontend keeps calling it unchanged.
-- ============================================================================
--
-- WHY THIS WAS NEEDED
--
-- A Daily Project Report row is not one expense -- it's a GROUP of every
-- expense sharing the same (track_date, user_id, project_id), e.g. every
-- line of a multi-line batch submitted for the same trip/project. The
-- "Remarks" header has existed in DAILY_PROJECT_REPORT_HEADERS since this
-- report was first built, but was never wired to any data source -- every
-- row shipped with Remarks hardcoded to "". Meanwhile each individual
-- expense already has its own free-text "Remark" (the base `purpose`
-- column, shown as "Remark" in Batch Review after this org's own field
-- relabeling). The fix: carry `purpose` through in source_expenses (which
-- this function already builds, one entry per underlying expense, per
-- group) so the frontend can comma-join every non-empty remark in that
-- group's own natural (trip_start, category, id) order -- exactly the order
-- source_expenses is already emitted in.
--
-- This migration ONLY adds 'purpose' to the source_expenses jsonb payload.
-- Every other line of the function is byte-identical to
-- 20260826100000_daily_report_dynamic_project_name.sql's version -- no
-- other resolution logic changes.
-- ─────────────────────────────────────────────────────────────────────────────

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

  WITH filtered AS (
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
               -- 'dynamic': resolved via THIS row's own project_id value, not
               -- a fixed field id. Only meaningful when projectId itself
               -- resolves via template/branch (fv_pid must exist) -- if
               -- projectId is 'base' or 'none', there is no per-project
               -- branch tree to search, so dynamic project_name is ''.
               WHEN 'dynamic'  THEN btrim(COALESCE(fv_pnm_dyn.field_value, ''))
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
    -- New: dynamic per-project Project Name lookup. parent_template_id is
    -- fixed to v_pid_uuid (projectId's OWN configured template/branch id --
    -- the parent every one of its option branches was created under), never
    -- to v_pnm_uuid (there is no fixed projectName id to anchor to, which is
    -- the entire point of 'dynamic'). Guarded on v_pid_kind IN
    -- ('template','branch') so it never fires when projectId has no
    -- per-project branch tree to search (e.g. projectId = 'base:...').
    LEFT JOIN LATERAL (
      SELECT dv.field_value
      FROM public.expense_form_field_option_branches db
      JOIN public.expense_form_field_values dv
        ON dv.branch_field_id = db.id AND dv.organization_id = f.organization_id
      WHERE db.parent_template_id = v_pid_uuid
        AND db.field_key = 'project_name'
        AND db.organization_id = f.organization_id
        AND db.parent_option_value = fv_pid.field_value
        AND dv.expense_id = f.id
      ORDER BY db.created_at, db.id
      LIMIT 1
    ) fv_pnm_dyn ON v_pnm_kind = 'dynamic'
                AND v_pid_kind IN ('template', 'branch')
                AND fv_pid.field_value IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT v.field_value FROM public.expense_form_field_values v
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND ((v_loc_kind = 'template' AND v.template_id     = v_loc_uuid)
          OR (v_loc_kind = 'branch'   AND v.branch_field_id = v_loc_uuid))
      LIMIT 1
    ) fv_loc ON v_loc_kind IN ('template', 'branch')
  ),
  grouped AS (
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
             'cost_column',        g.cost_column,
             'purpose',            g.purpose
           ) ORDER BY g.trip_start, g.category, g.id) AS source_expenses
    FROM enriched g
    GROUP BY g.track_date_key, g.user_id, btrim(g.project_id)
  ),
  denom AS (
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
  'DOC-101 + DOC-113 + Remarks fix. One bounded page of Daily Project Report '
  'rows. source_expenses now carries each expense''s own `purpose` (shown as '
  '"Remark" after org relabeling) so the frontend can populate the Remarks '
  'column by comma-joining every non-empty remark in a grouped row.';

NOTIFY pgrst, 'reload schema';
