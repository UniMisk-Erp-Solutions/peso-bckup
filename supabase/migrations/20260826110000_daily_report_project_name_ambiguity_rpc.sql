-- DOC-113 follow-up — flag genuinely-unresolvable Project Name cells in the
-- exported Daily Project Report file itself (CSV and Excel), per explicit
-- user request after the DOC-113 fix shipped.
--
-- ============================================================================
-- STATUS: authored for peso-bckup only. NOT applied to Production.
-- Purely additive: one new read-only RPC. No existing function/table/policy
-- is touched.
-- ============================================================================
--
-- Kept as its own small RPC rather than folded into
-- get_daily_project_report_page_v1's envelope: this is a distinct, cheap,
-- org-wide fact (which Project IDs have more than one name on record) that
-- does not depend on pagination, filters, or the caller's team scope, and
-- keeping it separate avoids ever having to bump DAILY_REPORT_SCHEMA_VERSION
-- on the client for an unrelated concern.
--
-- Computed LIVE from current data every call -- never a frozen snapshot of
-- the 2026-08-26 analysis, so it stays correct as new expenses are added
-- (an org could grow a THIRD ambiguous Project ID next month; this reflects
-- it immediately, with no code change).
--
-- Only meaningful when the org's projectName mapping is 'dynamic' (see
-- 20260826100000_daily_report_dynamic_project_name.sql) -- for any other
-- kind, there is no per-project branch tree to search, so this returns an
-- empty set (correctly: a fixed template/branch mapping cannot be
-- "ambiguous" in this sense).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_daily_report_project_name_ambiguity_v1(
  p_organization_id uuid
)
RETURNS TABLE(project_id text, distinct_name_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg      jsonb;
  v_pid_kind text; v_pid_key text; v_pid_uuid uuid;
  v_pnm_kind text; v_pnm_key text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;

  -- Same permission gate as the report itself. Org-wide fact, not
  -- team-scoped -- ambiguity doesn't vary by who is asking.
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, false) THEN
    RAISE EXCEPTION 'not permitted to view this report metadata' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) INTO v_cfg
  FROM public.organization_settings s
  WHERE s.organization_id = p_organization_id;

  v_cfg := COALESCE(v_cfg, '{}'::jsonb);

  SELECT k, v INTO v_pid_kind, v_pid_key
  FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectId}') AS s(k, v);
  SELECT k, v INTO v_pnm_kind, v_pnm_key
  FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectName}') AS s(k, v);

  IF v_pnm_kind <> 'dynamic' OR v_pid_kind NOT IN ('template', 'branch') THEN
    RETURN; -- empty set: nothing to be ambiguous about under this mapping
  END IF;

  v_pid_uuid := v_pid_key::uuid;

  RETURN QUERY
  SELECT b.parent_option_value,
         COUNT(DISTINCT v.field_value)::integer
  FROM public.expense_form_field_option_branches b
  JOIN public.expense_form_field_values v
    ON v.branch_field_id = b.id AND v.organization_id = b.organization_id
  JOIN public.expenses e ON e.id = v.expense_id AND e.status = 'approved'
  WHERE b.parent_template_id = v_pid_uuid
    AND b.field_key = 'project_name'
    AND b.organization_id = p_organization_id
    AND btrim(COALESCE(v.field_value, '')) <> ''
  GROUP BY b.parent_option_value
  HAVING COUNT(DISTINCT v.field_value) > 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_report_project_name_ambiguity_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_daily_report_project_name_ambiguity_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_daily_report_project_name_ambiguity_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_daily_report_project_name_ambiguity_v1(uuid) IS
  'DOC-113 follow-up. Project IDs with more than one distinct Project Name '
  'ever recorded across the org -- used by the export to flag genuinely '
  'ambiguous cells rather than silently picking one. Live-computed, not a '
  'frozen snapshot.';

NOTIFY pgrst, 'reload schema';
