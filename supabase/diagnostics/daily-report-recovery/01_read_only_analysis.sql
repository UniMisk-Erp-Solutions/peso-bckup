-- Daily Project Report — Project Name/ID resolution health check.
-- LAYER 1 of 4. READ-ONLY. Zero side effects. Safe to run against any
-- environment at any time. See README.md in this directory for the full
-- three-layer design and why layers 2/3 are optional and gated.
--
-- Substitute :organization_id before running. There is deliberately no
-- default / no-argument mode.

-- ── A. Resolution-tier breakdown for "project name" ─────────────────────────
-- Mirrors report_daily_project_rows_v1's own COALESCE chain exactly, so this
-- reports the SAME tiers the live report already applies at read time.
WITH cfg AS (
  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) AS v_cfg
  FROM public.organization_settings s
  WHERE s.organization_id = :'organization_id'::uuid
),
parsed AS (
  SELECT
    (SELECT k FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectId}') s(k, v))   AS pid_kind,
    (SELECT v FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectId}') s(k, v))   AS pid_key,
    (SELECT k FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectName}') s(k, v)) AS pnm_kind,
    (SELECT v FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectName}') s(k, v)) AS pnm_key
  FROM cfg
),
base AS (
  SELECT e.id, e.title, e.destination, e.purpose, e.category, e.trip_start, e.total_amount
  FROM public.expenses e
  WHERE e.organization_id = :'organization_id'::uuid
    AND e.status = 'approved'
),
enriched AS (
  SELECT
    b.id,
    COALESCE(CASE p.pid_kind
      WHEN 'base' THEN public._daily_report_base_value_v1(p.pid_key, b.title, b.destination, b.purpose, b.category, b.trip_start, b.total_amount)
      WHEN 'template' THEN btrim(COALESCE(fv_pid.field_value, ''))
      WHEN 'branch'   THEN btrim(COALESCE(fv_pid.field_value, ''))
      ELSE '' END, '') AS project_id,
    COALESCE(CASE p.pnm_kind
      WHEN 'base' THEN public._daily_report_base_value_v1(p.pnm_key, b.title, b.destination, b.purpose, b.category, b.trip_start, b.total_amount)
      WHEN 'template' THEN btrim(COALESCE(fv_pnm.field_value, ''))
      WHEN 'branch'   THEN btrim(COALESCE(fv_pnm.field_value, ''))
      ELSE '' END, '') AS project_name_configured,
    btrim(COALESCE(fv_pnm_branch.field_value, '')) AS project_name_branch
  FROM base b
  CROSS JOIN parsed p
  LEFT JOIN LATERAL (
    SELECT v.field_value FROM public.expense_form_field_values v
    WHERE v.expense_id = b.id AND v.organization_id = :'organization_id'::uuid
      AND ((p.pid_kind = 'template' AND v.template_id::text     = p.pid_key)
        OR (p.pid_kind = 'branch'   AND v.branch_field_id::text = p.pid_key))
    LIMIT 1) fv_pid ON p.pid_kind IN ('template', 'branch')
  LEFT JOIN LATERAL (
    SELECT v.field_value FROM public.expense_form_field_values v
    WHERE v.expense_id = b.id AND v.organization_id = :'organization_id'::uuid
      AND ((p.pnm_kind = 'template' AND v.template_id::text     = p.pnm_key)
        OR (p.pnm_kind = 'branch'   AND v.branch_field_id::text = p.pnm_key))
    LIMIT 1) fv_pnm ON p.pnm_kind IN ('template', 'branch')
  LEFT JOIN LATERAL (
    SELECT v.field_value
    FROM public.expense_form_field_values v
    JOIN public.expense_form_field_option_branches ob ON ob.id = v.branch_field_id
    WHERE v.expense_id = b.id AND v.organization_id = :'organization_id'::uuid
      AND ob.field_key = 'project_name'
    ORDER BY ob.display_order, ob.id
    LIMIT 1) fv_pnm_branch ON true
),
resolved AS (
  SELECT en.*,
         CASE
           WHEN NULLIF(en.project_name_configured, '') IS NOT NULL THEN 'configured'
           WHEN NULLIF(en.project_name_branch, '') IS NOT NULL THEN 'submitted_on_expense'
           WHEN defn.def_name IS NOT NULL THEN 'single_option_definition_fallback'
           ELSE 'unresolved'
         END AS resolution_tier
  FROM enriched en
  LEFT JOIN LATERAL (
    SELECT btrim(ob.options ->> 0) AS def_name
    FROM public.expense_form_field_option_branches ob
    WHERE ob.organization_id = :'organization_id'::uuid
      AND ob.field_key = 'project_name'
      AND ob.parent_option_value = en.project_id
      AND jsonb_array_length(COALESCE(ob.options, '[]'::jsonb)) = 1
    ORDER BY ob.retired_at NULLS FIRST, ob.display_order, ob.id
    LIMIT 1) defn
    ON btrim(COALESCE(en.project_name_configured, '')) = ''
   AND btrim(COALESCE(en.project_name_branch, '')) = ''
   AND btrim(COALESCE(en.project_id, '')) <> ''
)
SELECT resolution_tier, count(*) AS expense_count
FROM resolved
GROUP BY resolution_tier
ORDER BY expense_count DESC;

-- ── B. Ambiguous project ids ─────────────────────────────────────────────
-- Same signal as the shared core's `ambiguity` CTE: project ids with 2+
-- distinct real submitted project_name values across sibling expenses.
WITH submitted AS (
  SELECT ob.parent_option_value AS project_id, v.field_value AS project_name
  FROM public.expense_form_field_values v
  JOIN public.expense_form_field_option_branches ob ON ob.id = v.branch_field_id
  JOIN public.expenses e ON e.id = v.expense_id
  WHERE v.organization_id = :'organization_id'::uuid
    AND e.organization_id = :'organization_id'::uuid
    AND e.status = 'approved'
    AND ob.field_key = 'project_name'
    AND btrim(COALESCE(ob.parent_option_value, '')) <> ''
    AND btrim(COALESCE(v.field_value, '')) <> ''
)
SELECT project_id, count(DISTINCT project_name) AS distinct_names_recorded,
       array_agg(DISTINCT project_name ORDER BY project_name) AS names
FROM submitted
GROUP BY project_id
HAVING count(DISTINCT project_name) > 1
ORDER BY distinct_names_recorded DESC, project_id;

-- ── C. Unresolved "project id" itself (rarer -- project_id has no analogous
-- fallback chain; a blank project_id renders as "N/A - no data on record"
-- with no recovery path at all, deterministic or otherwise) ────────────────
SELECT count(*) AS expenses_with_no_resolvable_project_id
FROM (
  SELECT b.id
  FROM base b
  CROSS JOIN parsed p
  LEFT JOIN LATERAL (
    SELECT v.field_value FROM public.expense_form_field_values v
    WHERE v.expense_id = b.id AND v.organization_id = :'organization_id'::uuid
      AND ((p.pid_kind = 'template' AND v.template_id::text     = p.pid_key)
        OR (p.pid_kind = 'branch'   AND v.branch_field_id::text = p.pid_key))
    LIMIT 1) fv_pid ON p.pid_kind IN ('template', 'branch')
  WHERE btrim(COALESCE(CASE p.pid_kind
    WHEN 'base' THEN public._daily_report_base_value_v1(p.pid_key, b.title, b.destination, b.purpose, b.category, b.trip_start, b.total_amount)
    WHEN 'template' THEN fv_pid.field_value
    WHEN 'branch'   THEN fv_pid.field_value
    ELSE '' END, '')) = ''
) x;
