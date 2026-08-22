-- DOC-106 — per-report generation history.
--
-- Every generated report already leaves a row in report_export_jobs with who
-- asked for it, when, how many rows and where the file went. Nothing surfaced
-- it, so a user who wanted yesterday's file had to regenerate it. This exposes
-- that history per report type.
--
-- Why an RPC rather than a PostgREST select: the history needs the requester's
-- NAME, which lives in profiles. Letting the client join profiles to satisfy a
-- report list would widen what it can read about colleagues; resolving the name
-- inside a SECURITY DEFINER function keeps that surface closed.
--
-- Files expire (report_export_jobs.expires_at defaults to now() + 7 days and
-- expire_report_export_files_v1 clears them), so the row reports whether the
-- file is still downloadable instead of offering a button that would 404.

BEGIN;

CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v1(
  p_organization_id uuid,
  p_report_type     text,
  p_limit           integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_rows  jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_report_type NOT IN (
    'daily_project_report', 'claim_verification', 'claim_approval', 'detailed_expense'
  ) THEN
    RAISE EXCEPTION 'unsupported report type: %', p_report_type USING ERRCODE = '22023';
  END IF;
  -- Same gate the reports themselves use: if you may not view the report, you
  -- may not see who has been generating it.
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, false) THEN
    RAISE EXCEPTION 'not permitted to view this report' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT j.id,
           j.status,
           j.filename,
           j.storage_path,
           j.file_size_bytes,
           j.progress_current AS row_count,
           j.created_at,
           j.completed_at,
           j.expires_at,
           COALESCE(NULLIF(btrim(COALESCE(p.name, '')), ''), 'Unknown user') AS requested_by_name,
           (j.requested_by = auth.uid())                                     AS requested_by_me,
           -- A row is only downloadable while the object is actually present.
           (j.status = 'completed'
            AND j.storage_path IS NOT NULL
            AND (j.expires_at IS NULL OR j.expires_at > now())
            AND EXISTS (
              SELECT 1 FROM storage.objects o
              WHERE o.bucket_id = 'generated-reports' AND o.name = j.storage_path
            ))                                                               AS downloadable
    FROM public.report_export_jobs j
    LEFT JOIN public.profiles p
           ON p.user_id = j.requested_by AND p.organization_id = j.organization_id
    WHERE j.organization_id = p_organization_id
      AND j.report_type = p_report_type
      AND j.status = 'completed'
    ORDER BY j.created_at DESC
    LIMIT v_limit
  ) x;

  RETURN jsonb_build_object('schema_version', 1, 'jobs', COALESCE(v_rows, '[]'::jsonb));
END;
$fn$;

REVOKE ALL ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) TO authenticated;

COMMIT;
