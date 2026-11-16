-- Phase 3.6: stale job recovery + operator observability (dispatch via start-tally-sync Edge Function).

COMMENT ON TABLE public.tally_sync_jobs IS
  'Admin Tally sync jobs. Enqueue via create_tally_sync_job_v1; dispatch via start-tally-sync Edge (Phase 3.6).';

ALTER TABLE public.tally_sync_jobs
  ADD COLUMN IF NOT EXISTS dispatch_requested_at timestamptz;

COMMENT ON COLUMN public.tally_sync_jobs.dispatch_requested_at IS
  'Set when start-tally-sync accepted the job and requested worker dispatch.';

CREATE OR REPLACE FUNCTION public.mark_tally_sync_dispatch_requested_v1(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.tally_sync_jobs
  SET dispatch_requested_at = now()
  WHERE id = p_job_id AND status IN ('queued', 'processing');
END;
$$;

REVOKE ALL ON FUNCTION public.mark_tally_sync_dispatch_requested_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_tally_sync_dispatch_requested_v1(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_tally_sync_dispatch_requested_v1(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.recover_stale_tally_sync_jobs_v1(
  p_stale_after interval DEFAULT interval '10 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requeued integer := 0;
  v_failed   integer := 0;
BEGIN
  WITH stale AS (
    SELECT id, attempt_count, max_attempts
    FROM public.tally_sync_jobs
    WHERE status = 'processing'
      AND COALESCE(worker_heartbeat_at, started_at, created_at) < now() - p_stale_after
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE public.tally_sync_jobs j
    SET status = CASE WHEN s.attempt_count < s.max_attempts THEN 'queued' ELSE 'failed' END,
        worker_id = CASE WHEN s.attempt_count < s.max_attempts THEN NULL ELSE worker_id END,
        error_code = CASE WHEN s.attempt_count < s.max_attempts THEN NULL ELSE 'stale_worker' END,
        error_message_safe = CASE
          WHEN s.attempt_count < s.max_attempts THEN NULL
          ELSE 'Preparation timed out'
        END
    FROM stale s
    WHERE j.id = s.id
    RETURNING j.id,
      CASE WHEN j.status = 'queued' THEN 1 ELSE 0 END AS rq,
      CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END AS fl
  )
  SELECT COALESCE(sum(rq), 0), COALESCE(sum(fl), 0) INTO v_requeued, v_failed FROM updated;

  RETURN jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_tally_sync_jobs_v1(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recover_stale_tally_sync_jobs_v1(interval) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_tally_sync_jobs_v1(interval) TO service_role;

COMMENT ON FUNCTION public.recover_stale_tally_sync_jobs_v1(interval) IS
  'Requeue stale processing Tally jobs. Pair with periodic run-tally-sync-job drain (no job_id) for ops.';
