-- Daily Project Report — guarded Class A/B project_name materialization WRITE.
-- LAYER 3 of 4. NOT RUN. NOT APPLIED. Requires manual owner review of
-- 02_prepared_materialization_dry_run.sql's output AND manual uncommenting
-- before this can execute at all. This file is not part of any migration,
-- deploy step, or automated job, and must never become one.
--
-- Preconditions before uncommenting anything below:
--   1. 02_prepared_materialization_dry_run.sql has been run against the SAME
--      :organization_id and its output has been reviewed line by line.
--   2. The owner has confirmed every row is genuinely Class A or B (the
--      dry run's own query already restricts to that, but re-verify against
--      README.md's classification table before writing anything).
--   3. This is being run against an environment the owner has explicitly
--      chosen -- this file assumes nothing about which environment that is.
--
-- Substitute :organization_id before running.

BEGIN;

-- Re-derive the EXACT same candidate set as the dry run, inline, inside the
-- transaction -- never write from a value captured in an earlier session,
-- since the underlying data could have changed between the dry run and now.
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
  SELECT DISTINCT v.expense_id
  FROM public.expense_form_field_values v
  JOIN public.expense_form_field_option_branches ob ON ob.id = v.branch_field_id
  WHERE v.organization_id = :'organization_id'::uuid AND ob.field_key = 'project_name'
),
class_a_names AS (
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
  SELECT ob.parent_option_value AS project_id, btrim(ob.options ->> 0) AS sole_option,
         ob.id AS target_branch_field_id
  FROM public.expense_form_field_option_branches ob
  WHERE ob.organization_id = :'organization_id'::uuid AND ob.field_key = 'project_name'
    AND jsonb_array_length(COALESCE(ob.options, '[]'::jsonb)) = 1
),
class_a_target_branch AS (
  SELECT ob.parent_option_value AS project_id, ob.id AS target_branch_field_id
  FROM public.expense_form_field_option_branches ob
  WHERE ob.organization_id = :'organization_id'::uuid AND ob.field_key = 'project_name'
),
candidates AS (
  SELECT ep.expense_id, ep.project_id, ca.sole_name AS recovered_value,
         cat.target_branch_field_id, 'A' AS recovery_class
  FROM expense_project ep
  JOIN class_a_names ca ON ca.project_id = ep.project_id
  JOIN class_a_target_branch cat ON cat.project_id = ep.project_id
  WHERE ep.expense_id NOT IN (SELECT expense_id FROM already_submitted)
    AND btrim(COALESCE(ep.project_id, '')) <> ''

  UNION ALL

  SELECT ep.expense_id, ep.project_id, cb.sole_option, cb.target_branch_field_id, 'B'
  FROM expense_project ep
  JOIN class_b_defs cb ON cb.project_id = ep.project_id
  WHERE ep.expense_id NOT IN (SELECT expense_id FROM already_submitted)
    AND ep.project_id NOT IN (SELECT project_id FROM class_a_names)
    AND btrim(COALESCE(ep.project_id, '')) <> ''
)
-- ─────────────────────────────────────────────────────────────────────────
-- UNCOMMENT ONLY AFTER MANUAL REVIEW. Left commented so this file cannot
-- write anything by being accidentally executed wholesale.
-- ─────────────────────────────────────────────────────────────────────────
-- INSERT INTO public.expense_form_field_values
--   (expense_id, organization_id, branch_field_id, field_value)
-- SELECT c.expense_id, :'organization_id'::uuid, c.target_branch_field_id, c.recovered_value
-- FROM candidates c
-- WHERE NOT EXISTS (
--   SELECT 1 FROM public.expense_form_field_values existing
--   WHERE existing.expense_id = c.expense_id
--     AND existing.organization_id = :'organization_id'::uuid
--     AND existing.branch_field_id = c.target_branch_field_id
-- );
--
-- -- Record exactly what was written for the rollback/audit trail this
-- -- README promises. Requires a `recovered_via` text column or an
-- -- equivalent audit table -- add one before uncommenting if it does not
-- -- already exist; do not write recovered rows without a way to identify
-- -- them afterward.
-- -- UPDATE public.expense_form_field_values SET recovered_via = 'daily-report-recovery-2026-08-27'
-- -- WHERE expense_id IN (SELECT expense_id FROM candidates) AND organization_id = :'organization_id'::uuid;

-- Count-check before committing: compare this to the dry run's row count.
-- If they don't match, ROLLBACK instead of COMMIT and re-investigate.
SELECT count(*) AS candidate_row_count FROM candidates;

ROLLBACK; -- Change to COMMIT only after the INSERT above is uncommented,
          -- reviewed, and the candidate_row_count matches the dry run.
