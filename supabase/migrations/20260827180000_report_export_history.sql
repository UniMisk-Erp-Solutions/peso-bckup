-- Server-side report generation, part 4 of 4 — per-report generation history
-- with re-download.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- Additive only: one new function. No existing table, column, RLS policy or
-- grant is modified.
-- ============================================================================
--
-- Ported from `origin/feature/preet-patel-changes`
-- (`20260822160000_report_export_history.sql`), functionally unchanged --
-- rewritten only to build each row explicitly (jsonb_build_object) instead of
-- `to_jsonb()` over an inline subquery column list, for consistency with the
-- other three migrations in this integration. The JSON envelope
-- (`{schema_version, jobs: [...]}`) and every field name are unchanged and
-- were verified field-by-field against the source function before writing
-- this file, since `src/lib/reportExportJobs.ts`'s `listReportExportJobs()`
-- (ported unchanged in the frontend commit) destructures `data.jobs`.
--
-- Every generated report already leaves a row in report_export_jobs (parts 1
-- and 3) recording who asked for it, when, how many rows and where the file
-- went. This surfaces it: each of the four Reports tabs lists its OWN
-- history, scoped to that report type, under its Generate panel.
--
-- An RPC rather than a PostgREST select, deliberately. The history needs the
-- requester's NAME, which lives in profiles. Letting the client join profiles
-- to satisfy a report list would widen what it can read about colleagues;
-- resolving the name inside a SECURITY DEFINER function keeps that surface
-- closed. It is gated by the same daily_report_caller_can_view_v1 check as
-- the reports themselves: if you may not view a report type, you may not see
-- who has been generating it.
--
-- `downloadable` folds three independent conditions into one boolean: job
-- status, expiry timestamp, AND the object actually existing in Storage --
-- so an expired row (or one whose file was separately removed) stays visible
-- as a record of who generated what, but never offers a Download button that
-- would 404.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v1(
  p_organization_id uuid,
  p_report_type     text,
  p_limit           integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_uid   uuid := auth.uid();
  v_out   jsonb;
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
      -- A row is only downloadable while the object is actually present.
      'downloadable', (
        j.status = 'completed'
        AND j.storage_path IS NOT NULL
        AND (j.expires_at IS NULL OR j.expires_at > now())
        AND EXISTS (
          SELECT 1 FROM storage.objects o
          WHERE o.bucket_id = 'generated-reports' AND o.name = j.storage_path
        )
      )
    ) ORDER BY j.created_at DESC), '[]'::jsonb)
  ) INTO v_out
  FROM (
    SELECT *
    FROM public.report_export_jobs
    WHERE organization_id = p_organization_id
      AND report_type = p_report_type
      AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT v_limit
  ) j
  LEFT JOIN public.profiles p ON p.user_id = j.requested_by AND p.organization_id = j.organization_id;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_report_export_jobs_v1(uuid, text, integer) TO authenticated;
