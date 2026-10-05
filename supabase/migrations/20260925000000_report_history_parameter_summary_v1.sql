-- Report History: per-job parameter summary (owner QA fix pass, 2026-09-23).
--
-- WHY A NEW VERSIONED RPC, NOT AN EDIT TO v2:
-- list_report_export_jobs_v2 is already live in Production (applied
-- 2026-09-23, see detailed-expense-report-preview.md §9a). Changing its
-- return shape in place would be a live contract break for anything already
-- calling it. list_report_export_jobs_v1 and _v2 are both left completely
-- untouched; v3 is purely additive.
--
-- WHAT THIS ADDS:
-- report_export_jobs.parameters already stores the exact filter jsonb the
-- job was enqueued with (create_expense_report_export_job_v1's p_filters,
-- stored verbatim) -- it was already a frozen, per-job snapshot, just never
-- surfaced to the list RPC. v3 returns it as `parameters`, plus a
-- server-resolved `employee_display` (name + employee code, never a raw
-- UUID) for the single-employee case, resolved from the job's OWN stored
-- parameters.user_id, not from anything the caller currently has selected in
-- the UI -- so a history row's summary can never drift when someone changes
-- today's filter controls (owner's explicit requirement).

CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v3(
  p_organization_id uuid,
  p_report_type     text,
  p_offset          integer DEFAULT 0,
  p_limit           integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_uid    uuid := auth.uid();
  v_out    jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_report_type NOT IN ('daily_project_report', 'claim_verification', 'claim_approval', 'detailed_expense') THEN
    RAISE EXCEPTION 'unsupported report type' USING ERRCODE = '22023';
  END IF;
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, false) THEN
    RAISE EXCEPTION 'not permitted to view this report' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'schema_version', 1,
    'offset', v_offset,
    'limit', v_limit,
    'total_count', (
      SELECT count(*)::integer FROM public.report_export_jobs
      WHERE organization_id = p_organization_id AND report_type = p_report_type AND status = 'completed'
    ),
    'jobs', COALESCE(jsonb_agg(jsonb_build_object(
      'id', j.id,
      'status', j.status,
      'filename', j.filename,
      'storage_path', j.storage_path,
      'file_size_bytes', j.file_size_bytes,
      'row_count', j.progress_current,
      'created_at', j.created_at,
      'completed_at', j.completed_at,
      'expires_at', j.expires_at,
      'requested_by_name', COALESCE(NULLIF(btrim(COALESCE(p.name, '')), ''), 'Unknown user'),
      'requested_by_me', (j.requested_by = v_uid),
      'downloadable', (
        j.status = 'completed'
        AND j.storage_path IS NOT NULL
        AND (j.expires_at IS NULL OR j.expires_at > now())
        AND EXISTS (
          SELECT 1 FROM storage.objects o
          WHERE o.bucket_id = 'generated-reports' AND o.name = j.storage_path
        )
      ),
      'has_preview', (j.preview_columns IS NOT NULL),
      -- Frozen exactly as stored at enqueue time -- never re-derived from
      -- the caller's current filter selections.
      'parameters', COALESCE(j.parameters, '{}'::jsonb),
      'employee_display', CASE
        WHEN NULLIF(j.parameters->>'user_id', '') IS NULL THEN NULL
        ELSE COALESCE(NULLIF(btrim(COALESCE(ep.name, '')), ''), 'Employee') ||
             CASE WHEN NULLIF(btrim(COALESCE(ep.employee_id, '')), '') IS NOT NULL
                  THEN ' (' || ep.employee_id || ')'
                  ELSE ''
             END
      END
    ) ORDER BY j.created_at DESC), '[]'::jsonb)
  ) INTO v_out
  FROM (
    SELECT *
    FROM public.report_export_jobs
    WHERE organization_id = p_organization_id
      AND report_type = p_report_type
      AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) j
  LEFT JOIN public.profiles p ON p.user_id = j.requested_by AND p.organization_id = j.organization_id
  LEFT JOIN public.profiles ep
    ON ep.user_id = NULLIF(j.parameters->>'user_id', '')::uuid
   AND ep.organization_id = j.organization_id;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.list_report_export_jobs_v3(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_report_export_jobs_v3(uuid, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_report_export_jobs_v3(uuid, text, integer, integer) TO authenticated;

DO $verify$
BEGIN
  IF to_regprocedure('public.list_report_export_jobs_v3(uuid, text, integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'list_report_export_jobs_v3 missing';
  END IF;
  -- v1/v2 must remain exactly as they were -- this migration never touches them.
  IF to_regprocedure('public.list_report_export_jobs_v1(uuid, text, integer)') IS NULL THEN
    RAISE EXCEPTION 'list_report_export_jobs_v1 missing (must not have been dropped)';
  END IF;
  IF to_regprocedure('public.list_report_export_jobs_v2(uuid, text, integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'list_report_export_jobs_v2 missing (must not have been dropped)';
  END IF;
  IF has_function_privilege('anon', 'public.list_report_export_jobs_v3(uuid, text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on list_report_export_jobs_v3';
  END IF;
  RAISE NOTICE 'report_history_parameter_summary_v1 migration verified OK';
END;
$verify$;
