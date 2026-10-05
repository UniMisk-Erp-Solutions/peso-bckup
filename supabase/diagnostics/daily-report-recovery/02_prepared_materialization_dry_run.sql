-- Daily Project Report — prepared Class A/B project_name materialization.
-- LAYER 2 of 4. READ-ONLY. Zero side effects. Shows exactly what Layer 3
-- would write, and nothing more -- Layer 3's guard is this exact same
-- predicate, so nothing can be written that this dry run did not show.
--
-- Substitute :organization_id before running.
--
-- Scope: only rows where the report's own read-time fallback chain already
-- resolves a name (Class A: a single, unambiguous, actually-submitted name
-- exists elsewhere for the same project id; Class B: the branch definition
-- has exactly one option) but this specific expense's own
-- expense_form_field_values row for project_name is missing. Materializing
-- these is a pure visibility/performance optimization for anywhere else in
-- the app that reads the raw submitted value directly (the report itself
-- already shows the correct value without this, via the read-time
-- fallback). Class C/D/E/F (inference, majority-vote, no-signal) never
-- appear here by construction -- see README.md.

WITH cfg AS (
  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) AS v_cfg
  FROM public.organization_settings s
  WHERE s.organization_id = :'organization_id'::uuid
),
parsed AS (
  SELECT
    (SELECT k FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectId}') s(k, v)) AS pid_kind,
    (SELECT v FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectId}') s(k, v)) AS pid_key
  FROM cfg
),
base AS (
  SELECT e.id, e.title, e.destination, e.purpose, e.category, e.trip_start, e.total_amount
  FROM public.expenses e
  WHERE e.organization_id = :'organization_id'::uuid
    AND e.status = 'approved'
),
expense_project AS (
  SELECT b.id AS expense_id,
         COALESCE(CASE p.pid_kind
           WHEN 'base' THEN public._daily_report_base_value_v1(p.pid_key, b.title, b.destination, b.purpose, b.category, b.trip_start, b.total_amount)
           WHEN 'template' THEN btrim(COALESCE(fv_pid.field_value, ''))
           WHEN 'branch'   THEN btrim(COALESCE(fv_pid.field_value, ''))
           ELSE '' END, '') AS project_id
  FROM base b
  CROSS JOIN parsed p
  LEFT JOIN LATERAL (
    SELECT v.field_value FROM public.expense_form_field_values v
    WHERE v.expense_id = b.id AND v.organization_id = :'organization_id'::uuid
      AND ((p.pid_kind = 'template' AND v.template_id::text     = p.pid_key)
        OR (p.pid_kind = 'branch'   AND v.branch_field_id::text = p.pid_key))
    LIMIT 1) fv_pid ON p.pid_kind IN ('template', 'branch')
),
already_submitted AS (
  -- Expenses that already have SOME project_name-branch value (nothing to
  -- materialize -- they are not missing anything).
  SELECT DISTINCT v.expense_id
  FROM public.expense_form_field_values v
  JOIN public.expense_form_field_option_branches ob ON ob.id = v.branch_field_id
  WHERE v.organization_id = :'organization_id'::uuid AND ob.field_key = 'project_name'
),
class_a_names AS (
  -- Class A: exactly one distinct real submitted name exists anywhere for
  -- this project id (i.e. NOT in the ambiguous set from 01's query B).
  SELECT ob.parent_option_value AS project_id,
         (array_agg(DISTINCT v.field_value))[1] AS sole_name
  FROM public.expense_form_field_values v
  JOIN public.expense_form_field_option_branches ob ON ob.id = v.branch_field_id
  JOIN public.expenses e ON e.id = v.expense_id
  WHERE v.organization_id = :'organization_id'::uuid AND e.organization_id = :'organization_id'::uuid
    AND e.status = 'approved' AND ob.field_key = 'project_name'
    AND btrim(COALESCE(v.field_value, '')) <> ''
  GROUP BY ob.parent_option_value
  HAVING count(DISTINCT v.field_value) = 1
),
class_b_defs AS (
  -- Class B: the branch definition has exactly one option for this project id.
  SELECT ob.parent_option_value AS project_id, btrim(ob.options ->> 0) AS sole_option,
         ob.id AS target_branch_field_id
  FROM public.expense_form_field_option_branches ob
  WHERE ob.organization_id = :'organization_id'::uuid AND ob.field_key = 'project_name'
    AND jsonb_array_length(COALESCE(ob.options, '[]'::jsonb)) = 1
),
class_a_target_branch AS (
  -- The specific option-branch row to attach a Class A value to (same
  -- lookup key as Class B, just carrying the Class A name instead).
  SELECT ob.parent_option_value AS project_id, ob.id AS target_branch_field_id
  FROM public.expense_form_field_option_branches ob
  WHERE ob.organization_id = :'organization_id'::uuid AND ob.field_key = 'project_name'
)
SELECT ep.expense_id, :'organization_id'::uuid AS organization_id, ep.project_id,
       'A' AS recovery_class, ca.sole_name AS recovered_value,
       cat.target_branch_field_id
FROM expense_project ep
JOIN class_a_names ca ON ca.project_id = ep.project_id
JOIN class_a_target_branch cat ON cat.project_id = ep.project_id
WHERE ep.expense_id NOT IN (SELECT expense_id FROM already_submitted)
  AND btrim(COALESCE(ep.project_id, '')) <> ''

UNION ALL

SELECT ep.expense_id, :'organization_id'::uuid, ep.project_id,
       'B' AS recovery_class, cb.sole_option AS recovered_value,
       cb.target_branch_field_id
FROM expense_project ep
JOIN class_b_defs cb ON cb.project_id = ep.project_id
WHERE ep.expense_id NOT IN (SELECT expense_id FROM already_submitted)
  AND ep.project_id NOT IN (SELECT project_id FROM class_a_names)  -- Class A takes precedence, matching the read-time COALESCE order
  AND btrim(COALESCE(ep.project_id, '')) <> ''

ORDER BY expense_id;

-- Expect: zero rows if the org's report is already showing every value it
-- can via the read-time fallback -- which it always is, since Layer 1's
-- "resolution_tier" breakdown already reflects live report output. A
-- non-empty result here means "these values COULD additionally be
-- persisted," not "the report is currently wrong."
