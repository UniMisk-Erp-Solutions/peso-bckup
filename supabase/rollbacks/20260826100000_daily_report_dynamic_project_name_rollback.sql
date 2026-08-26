-- Rollback for 20260826100000_daily_report_dynamic_project_name.sql
--
-- Restores MicroLink's config to the pre-fix (broken) mapping, and restores
-- both functions to their DOC-101 bodies (20260820160000). Does NOT touch
-- the 463 rows written by the separate DOC-113 data-recovery writes -- those
-- were a distinct action (390 Project Name + 73 Project ID inserts) and are
-- correct, real recovered data independent of this SQL-logic fix; rolling
-- back the resolver does not un-recover them.

UPDATE public.organization_settings
SET daily_expense_report_config = jsonb_set(
  daily_expense_report_config,
  '{fieldMappings,projectName}',
  '"template:7ae2b9f5-9c7a-456c-9403-314680526741"'
)
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND daily_expense_report_config #>> '{fieldMappings,projectName}' = 'dynamic:project_name_by_project_id';

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

-- get_daily_project_report_page_v1's pre-fix body: restore from
-- 20260820160000_daily_project_report_server_pagination.sql verbatim (not
-- repeated here for length -- re-run that migration's CREATE OR REPLACE
-- block to fully revert function #2).

NOTIFY pgrst, 'reload schema';
