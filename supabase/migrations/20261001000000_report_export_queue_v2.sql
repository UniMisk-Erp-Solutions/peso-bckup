-- Report export queue hardening (MicroLink report incident, 2026-09-24).
--
-- 1) claim_report_export_job_v2: claim ONE SPECIFIC queued job (the one a
--    user just enqueued) instead of the globally oldest queued job. Same
--    safety as v1 (row lock + SKIP LOCKED, cancellation honoured, per-org
--    running cap, service_role only). v1 is untouched and stays the
--    fallback used by the cron backstop.
-- 2) list_report_export_jobs_v4: report history across ALL lifecycle states
--    (queued / running / completed / failed / cancelled). v3 only ever
--    listed completed jobs, which made a failed or still-running job look
--    like "nothing happened". Adds progress, timing, a safe error message
--    for failed jobs only, and a stale flag. v1/v2/v3 are untouched.
--
-- No financial table is read or written. No raw error text is exposed:
-- error_message_safe is already sanitised by the worker.

CREATE OR REPLACE FUNCTION public.claim_report_export_job_v2(
  p_worker_id   text,
  p_job_id      uuid,
  p_max_per_org integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job    public.report_export_jobs%ROWTYPE;
  v_status text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'job id is required' USING ERRCODE = '22023';
  END IF;

  SELECT j.* INTO v_job
  FROM public.report_export_jobs j
  WHERE j.id = p_job_id
    AND j.status = 'queued'
    AND j.cancel_requested_at IS NULL
    AND (
      SELECT count(*) FROM public.report_export_jobs r
      WHERE r.organization_id = j.organization_id AND r.status = 'running'
    ) < GREATEST(COALESCE(p_max_per_org, 1), 1)
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    SELECT status INTO v_status FROM public.report_export_jobs WHERE id = p_job_id;
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', CASE
        WHEN v_status IS NULL THEN 'not_found'
        WHEN v_status = 'queued' THEN 'blocked_or_locked'
        ELSE 'not_queued'
      END
    );
  END IF;

  UPDATE public.report_export_jobs
  SET status = 'running',
      worker_id = p_worker_id,
      started_at = COALESCE(started_at, now()),
      worker_heartbeat_at = now(),
      attempt_count = attempt_count + 1,
      error_code = NULL,
      error_message_safe = NULL
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object('claimed', true, 'job', to_jsonb(v_job));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) TO service_role;

COMMENT ON FUNCTION public.claim_report_export_job_v2(text, uuid, integer) IS
  'Targeted claim of one specific queued report job (row lock, SKIP LOCKED, cancellation and per-org cap honoured). service_role only. v1 remains the global oldest-first claim for the cron backstop.';

CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v4(
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
    'schema_version', 4,
    'offset', v_offset,
    'limit', v_limit,
    'total_count', (
      SELECT count(*)::integer FROM public.report_export_jobs
      WHERE organization_id = p_organization_id AND report_type = p_report_type
    ),
    'jobs', COALESCE(jsonb_agg(jsonb_build_object(
      'id', j.id,
      'status', j.status,
      'filename', j.filename,
      'storage_path', j.storage_path,
      'file_size_bytes', j.file_size_bytes,
      'row_count', j.progress_current,
      'progress_current', j.progress_current,
      'progress_total', j.progress_total,
      'created_at', j.created_at,
      'started_at', j.started_at,
      'completed_at', j.completed_at,
      'expires_at', j.expires_at,
      'requested_by_name', COALESCE(NULLIF(btrim(COALESCE(p.name, '')), ''), 'Unknown user'),
      'requested_by_me', (j.requested_by = v_uid),
      -- Only a failed job exposes its (already sanitised) reason.
      'error_message_safe', CASE WHEN j.status = 'failed' THEN j.error_message_safe ELSE NULL END,
      'stale', (
        j.status = 'running'
        AND COALESCE(j.worker_heartbeat_at, j.started_at, j.created_at) < now() - interval '5 minutes'
      ),
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

REVOKE ALL ON FUNCTION public.list_report_export_jobs_v4(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_report_export_jobs_v4(uuid, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_report_export_jobs_v4(uuid, text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.list_report_export_jobs_v4(uuid, text, integer, integer) IS
  'Report history across all lifecycle states (queued/running/completed/failed/cancelled) for one report type, newest first. Same authorization as v3. Only failed jobs expose their sanitised error message.';

DO $verify$
BEGIN
  IF to_regprocedure('public.claim_report_export_job_v2(text, uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'claim_report_export_job_v2 missing';
  END IF;
  IF to_regprocedure('public.list_report_export_jobs_v4(uuid, text, integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'list_report_export_jobs_v4 missing';
  END IF;
  IF has_function_privilege('anon', 'public.claim_report_export_job_v2(text, uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_report_export_job_v2(text, uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'claim_report_export_job_v2 must be service_role only';
  END IF;
  IF has_function_privilege('anon', 'public.list_report_export_jobs_v4(uuid, text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute list_report_export_jobs_v4';
  END IF;
  RAISE NOTICE 'report_export_queue_v2 migration verified OK';
END;
$verify$;
