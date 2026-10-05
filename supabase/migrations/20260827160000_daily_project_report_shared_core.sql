-- Server-side report generation, part 2 of 4 — Daily Project Report shared
-- core, ported from `origin/feature/daily-project-report-export-jobs`
-- (`20260820180000_daily_project_report_shared_core.sql`) with no functional
-- changes beyond the port itself.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- Additive apart from CREATE OR REPLACE of get_daily_project_report_page_v1
-- (already on `main`, `20260820160000_daily_project_report_server_pagination.sql`),
-- whose signature and JSON return shape are UNCHANGED — verified field-by-field
-- against the version currently on `main` before writing this file. Existing
-- callers (`src/lib/dailyProjectReportPaging.ts`, already shipped and unchanged
-- by this integration) keep working identically; only the internals improve.
-- ============================================================================
--
-- WHY THIS REPLACES AN ALREADY-SHIPPED FUNCTION INSTEAD OF ADDING A NEW ONE
--
-- The worker being ported in part 3 needs a service-role-only function that
-- pages the Daily Project Report's rows with no auth.uid() gate (a worker has
-- no user session). The two Daily-Project-Report source branches that led to
-- this feature independently discovered two real, documented defects in that
-- computation while building exactly that function -- both are fixed here,
-- and BOTH the worker and the existing foreground RPC now share this single
-- corrected implementation instead of the bug living in two places:
--
-- 1. CORRECTNESS -- "project name" came out blank for every row in real data.
--    A configured projectName field mapping can point at a template that
--    holds zero value rows, because the real name is authored as a NESTED
--    SUB-OPTION: each "Project Unique ID" option has option-branch children
--    keyed 'project_id' and 'project_name' in
--    expense_form_field_option_branches. This function now falls back, in
--    order: the configured mapping's value -> the actual submitted
--    project_name sub-option value -> the project_name branch DEFINITION for
--    that project id (when it has exactly one option, i.e. an unambiguous
--    1:1 mapping) -- recovering rows whose sub-option value was never
--    persisted, without inventing anything.
--
-- 2. PERFORMANCE -- the per-row category-to-cost-column lookup was a
--    per-expense jsonb re-scan. At realistic data volumes this measured
--    solidly above the `authenticated` role's 8 second statement_timeout,
--    meaning a full-scope page of the existing RPC could be killed by
--    Postgres before ever returning. The category mapping is now flattened
--    ONCE into a small category -> cost_column relation and hash-joined.
--
-- 3. SHARED CORE -- report_daily_project_rows_v1 holds the whole computation.
--    get_daily_project_report_page_v1 becomes a thin authenticated wrapper
--    over it, and the worker calls the core directly with the job's frozen
--    config snapshot. There is exactly one implementation of the report's
--    SQL semantics, used by both the foreground RPC and the background job.
--
-- ============================================================================
-- AMENDED 2026-08-27 (daily-report-remarks-column integration) -- this
-- migration has NEVER been applied to any database, so this is an in-place
-- edit of the still-pending function body, not a second CREATE OR REPLACE
-- layered on top. Two lines added, nothing else in this function changes:
--
-- 4. REMARKS -- the "Remarks" export column has had a header since this
--    report was first built but was never wired to any data source. Each
--    underlying expense already has its own free-text remark (base
--    `purpose` column, commonly relabeled "Remark" per organization). The
--    `filtered` CTE below already selects `f.purpose` (it was already
--    needed for the project-id/name/location base-field resolution above),
--    but the `enriched` CTE was dropping it via an explicit column list
--    instead of carrying it forward -- so it never reached `source_expenses`.
--    Fixed by adding `f.purpose` to `enriched`'s SELECT list (it then
--    propagates through `resolved`'s `en.*` on its own) and adding
--    `'purpose', g.purpose` to the `source_expenses` jsonb_build_object in
--    `grouped`. The response's JSON CONTRACT is additive only: every
--    existing key in `source_expenses` is unchanged, this only adds one new
--    key. Both `get_daily_project_report_page_v1` (browser path) and the
--    worker's direct call to this function (background download path) read
--    `source_expenses[].purpose` from the exact same query, so the two
--    paths cannot drift the way they did on the source branch (see
--    Documentations MD/daily-report-remarks-column.md for the full incident
--    that made that drift real: the first Remarks fix touched only the
--    browser-side row builder and shipped with the actual downloaded CSV
--    still blank, because the worker was calling this function directly
--    with its own separate row-shaping code that never got `purpose` at
--    all).
-- ============================================================================
-- AMENDED 2026-08-27 (preet-daily-report-data-recovery-render integration) --
-- this migration has still never been applied to any database, so this is
-- another in-place edit of the still-pending function body.
--
-- 5. AMBIGUITY FLAGGING -- a row whose `project_name` resolves to '' can mean
--    two different things to the org reviewing the export: "nobody has ever
--    recorded a name for this project" versus "this project has been given
--    more than one conflicting name across different expenses, and picking
--    any single one would fabricate a fact." The source branch
--    (Preet-Patel/feature/daily-report-data-recovery-and-render) built a
--    read-only RPC, get_daily_report_project_name_ambiguity_v1, to detect the
--    second case -- but gated it behind an explicit `dynamic:` field-mapping
--    config kind that this lineage's project_name resolution (the
--    project_name_branch / branch-definition fallback chain added above)
--    does not use and never will: our fallback runs unconditionally for
--    every org, with no opt-in config value, so a config-kind gate would
--    silently never fire here. Rather than port that RPC as a second,
--    separately-called function -- which is exactly the "worker forgets to
--    call the second RPC" shape of bug the Remarks fix above was written to
--    prevent -- the same ambiguity signal is computed once, in this shared
--    core, from the same `enriched` rows already scanned for the name
--    resolution itself, and carried as a plain boolean on every row's JSON.
--    Both get_daily_project_report_page_v1 and the worker's direct call read
--    it from the exact same query; there is nothing a caller can forget.
--
--    Definition: a project_id is "ambiguous" when two or more DISTINCT,
--    non-blank project_name values have actually been SUBMITTED (via the
--    project_name option-branch) by different expenses sharing that
--    project_id. This mirrors the source RPC's own COUNT(DISTINCT ...) > 1
--    signal (real recorded values disagree), which is a different question
--    from whether the branch DEFINITION happens to offer more than one
--    option (that second condition can't produce a false "resolved" value
--    here, because the definition-fallback tier only ever fires when it
--    finds EXACTLY one option -- see the `defn` LATERAL join's
--    `jsonb_array_length(...) = 1` guard below). A row whose own
--    project_name is non-blank is never itself ambiguous, even if sibling
--    expenses under the same project_id disagree; the flag only matters to
--    the caller deciding what to render in place of a blank value. No marker
--    string is written here or anywhere in the database -- this migration
--    returns a boolean only; rendering "N/A - no data on record" vs.
--    "Ambiguous - multiple names on record, unresolved" is a presentation
--    decision made by resolveProjectIdCell/resolveProjectNameCell
--    (src/lib/dailyExpenseReportConfig.ts), called identically by the
--    foreground's finalizeDailyReportGroups
--    (src/lib/buildDailyProjectExpenseReport.ts) and by a byte-for-byte port
--    of the same two functions inside the worker
--    (supabase/functions/run-report-export-job/index.ts).
-- ============================================================================
-- ─────────────────────────────────────────────────────────────────────────────


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
  v_gucdummy  text;
BEGIN
  -- PERFORMANCE (added 2026-08-29, post-incident): under the default
  -- plan_cache_mode ('auto'), Postgres was observed executing this
  -- function's core WITH-query TWICE per call (proven via pg_stat_statements
  -- call counts on real Production data), presumably while comparing a
  -- custom plan against a generic one for this parameter-heavy query --
  -- measured at ~11.3s total against ~1.43s with a forced custom plan (a
  -- single execution). A plain `SET LOCAL plan_cache_mode = ...` statement
  -- is REJECTED by Postgres here ("SET is not allowed in a non-volatile
  -- function") because this function is STABLE -- caught by testing this
  -- exact migration against a throwaway copy of the database before ever
  -- touching Production. set_config(..., true) is a plain function call
  -- (not a SET utility statement), so it is permitted inside a STABLE
  -- function, and its third argument (is_local = true) gives it identical
  -- transaction-scoped semantics to SET LOCAL: it reverts automatically at
  -- the end of the current transaction and never affects any other session,
  -- database, or server-level state.
  v_gucdummy := set_config('plan_cache_mode', 'force_custom_plan', true);

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
  pid_core AS (
    -- PERFORMANCE (added 2026-08-29, see AMENDED note below): project_id and
    -- project_name_branch resolved once, narrowly, for exactly the two
    -- consumers that need them (`ambiguity` and `enriched`) -- see that note
    -- for why this exists as its own CTE instead of living inline in
    -- `enriched`.
    SELECT f.id,
           COALESCE(CASE v_pid_kind
             WHEN 'base' THEN public._daily_report_base_value_v1(v_pid_key, f.title, f.destination, f.purpose, f.category, f.trip_start, f.total_amount)
             WHEN 'template' THEN btrim(COALESCE(fv_pid.field_value, ''))
             WHEN 'branch'   THEN btrim(COALESCE(fv_pid.field_value, ''))
             ELSE '' END, '') AS project_id,
           btrim(COALESCE(fv_pnm_branch.field_value, '')) AS project_name_branch
    FROM filtered f
    LEFT JOIN LATERAL (
      SELECT v.field_value FROM public.expense_form_field_values v
      WHERE v.expense_id = f.id AND v.organization_id = f.organization_id
        AND ((v_pid_kind = 'template' AND v.template_id     = v_pid_uuid)
          OR (v_pid_kind = 'branch'   AND v.branch_field_id = v_pid_uuid))
      LIMIT 1) fv_pid ON v_pid_kind IN ('template', 'branch')
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
  enriched AS (
    SELECT f.id, f.user_id, f.trip_start, f.category, f.total_amount, f.title,
           f.transaction_number, f.purpose,
           pc.project_id,
           COALESCE(CASE v_pnm_kind
             WHEN 'base' THEN public._daily_report_base_value_v1(v_pnm_key, f.title, f.destination, f.purpose, f.category, f.trip_start, f.total_amount)
             WHEN 'template' THEN btrim(COALESCE(fv_pnm.field_value, ''))
             WHEN 'branch'   THEN btrim(COALESCE(fv_pnm.field_value, ''))
             ELSE '' END, '') AS project_name_configured,
           pc.project_name_branch,
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
    JOIN pid_core pc ON pc.id = f.id
    LEFT JOIN catmap cm ON cm.cat_lower = lower(btrim(COALESCE(f.category, '')))
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
  ),
  ambiguity AS (
    -- Real, actually-submitted project_name values disagree for this project
    -- id across two or more sibling expenses. See AMENDED 2026-08-27 note
    -- above for why this is computed once here instead of via a second RPC.
    --
    -- AMENDED 2026-08-29 (post-incident performance fix) -- this now reads
    -- from `pid_core` instead of `enriched`. `enriched` is a wide CTE (every
    -- column downstream consumers need: category, amounts, all four
    -- field-mapping lookups, voucher fields, ...); materializing it once and
    -- reading it back a SECOND time in full for this aggregate measured as
    -- catastrophically expensive against MicroLink's real ~12.6k-row
    -- production data (a live incident: a query that normally completes in
    -- ~8s hung for 2+ minutes) even though `enriched` is provably
    -- materialized only ONCE (confirmed via EXPLAIN -- Postgres does not
    -- re-run the four LATERAL joins twice). The second full-width re-scan
    -- itself was the cost: `pid_core` carries only the two columns this
    -- aggregate actually needs, so its own materialization is an order of
    -- magnitude narrower and the second scan no longer re-reads
    -- `enriched`'s full row width at all. `enriched` also now joins
    -- `pid_core` (on `id`, its primary key) for project_id/project_name_branch
    -- instead of computing them inline a second time, so the CASE-based
    -- project_id resolution logic still exists in exactly one place.
    SELECT btrim(pc.project_id) AS project_id_key,
           count(DISTINCT NULLIF(btrim(pc.project_name_branch), '')) > 1 AS is_ambiguous
    FROM pid_core pc
    WHERE btrim(COALESCE(pc.project_id, '')) <> ''
    GROUP BY btrim(pc.project_id)
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
           bool_or(COALESCE(amb.is_ambiguous, false)) AS project_name_ambiguous,
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
    LEFT JOIN ambiguity amb ON amb.project_id_key = btrim(g.project_id)
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
             'project_name_ambiguous', COALESCE(r.project_name_ambiguous, false),
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
  'THE Daily Project Report computation. Takes the mapping config as a '
  'parameter so the worker can pass the job''s frozen snapshot. Performs NO '
  'authorization: service_role only. The authenticated entry point is '
  'get_daily_project_report_page_v1, which checks permission and delegates here.';


-- ── The authenticated wrapper now delegates; no duplicated SQL ───────────────
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


-- ── Index supporting the nested-sub-option lookups ───────────────────────────
-- Justified: the project_name resolution probes option branches by
-- (organization_id, field_key, parent_option_value) once per expense in the
-- definition-fallback path, and by branch id via expense_form_field_values in
-- the stored-value path (already covered by idx_efv_org_expense_covering).
CREATE INDEX IF NOT EXISTS efv_option_branches_org_key_parent_idx
  ON public.expense_form_field_option_branches (organization_id, field_key, parent_option_value);
