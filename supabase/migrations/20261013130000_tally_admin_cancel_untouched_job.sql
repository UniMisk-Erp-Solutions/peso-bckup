-- Allow an organization admin to stop one untouched Tally sync job.
-- No claimed, delivered, failed, or manually held batch may be cancelled.

ALTER TABLE public.tally_sync_jobs
  DROP CONSTRAINT IF EXISTS tally_sync_jobs_status_check;

ALTER TABLE public.tally_sync_jobs
  ADD CONSTRAINT tally_sync_jobs_status_check CHECK (status IN (
    'queued', 'processing', 'prepared', 'waiting_for_connector', 'delivering',
    'completed', 'failed', 'cancelled'
  ));

CREATE OR REPLACE FUNCTION public.admin_cancel_untouched_tally_sync_job_v1(
  p_organization_id uuid,
  p_job_id uuid,
  p_reason text DEFAULT 'Cancelled by organization admin before delivery.'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_pending integer;
  v_non_pending integer;
  v_skipped_records bigint;
  v_updated integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.tally_sync_admin_can_view_v1(p_organization_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;

  -- Lock batches before the job, matching the connector claim lock order.
  PERFORM b.id
  FROM public.tally_sync_delivery_batches b
  WHERE b.job_id = p_job_id AND b.organization_id = p_organization_id
  ORDER BY b.batch_index
  FOR UPDATE;

  SELECT j.status INTO v_status
  FROM public.tally_sync_jobs j
  WHERE j.id = p_job_id AND j.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tally sync job not found in this organization' USING ERRCODE = '22023';
  END IF;
  IF v_status = 'cancelled' THEN
    RETURN jsonb_build_object('cancelled', true, 'already_cancelled', true, 'skipped_batches', 0);
  END IF;
  IF v_status NOT IN ('prepared', 'waiting_for_connector') THEN
    RAISE EXCEPTION 'job is not eligible for cancellation in status %', v_status USING ERRCODE = '22023';
  END IF;

  SELECT
    count(*) FILTER (WHERE b.status = 'pending')::integer,
    count(*) FILTER (WHERE b.status NOT IN ('pending', 'skipped'))::integer,
    COALESCE(sum(b.message_count) FILTER (WHERE b.status = 'pending'), 0)
  INTO v_pending, v_non_pending, v_skipped_records
  FROM public.tally_sync_delivery_batches b
  WHERE b.job_id = p_job_id AND b.organization_id = p_organization_id;

  IF v_pending = 0 OR v_non_pending <> 0 THEN
    RAISE EXCEPTION 'job has no pending batches or contains claimed, delivered, failed, or review batches' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tally_sync_delivery_batches b
  SET status = 'skipped',
      last_error_safe = left(COALESCE(NULLIF(p_reason, ''), 'Cancelled by organization admin before delivery.'), 500),
      ack_summary = COALESCE(b.ack_summary, '{}'::jsonb) || jsonb_build_object(
        'admin_cancelled', true,
        'cancelled_by', v_uid,
        'cancelled_at', now(),
        'cancel_reason', left(COALESCE(NULLIF(p_reason, ''), 'Cancelled by organization admin before delivery.'), 500)
      ),
      updated_at = now(),
      completed_at = COALESCE(b.completed_at, now())
  WHERE b.job_id = p_job_id
    AND b.organization_id = p_organization_id
    AND b.status = 'pending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_pending THEN
    RAISE EXCEPTION 'batch state changed during cancellation; no cancellation committed' USING ERRCODE = '40001';
  END IF;

  UPDATE public.tally_sync_jobs j
  SET status = 'cancelled',
      error_code = 'cancelled_by_admin',
      error_message_safe = 'Sync cancelled by an organization admin before delivery; pending batches were skipped.',
      completed_at = now()
  WHERE j.id = p_job_id
    AND j.organization_id = p_organization_id;

  RETURN jsonb_build_object(
    'cancelled', true,
    'already_cancelled', false,
    'skipped_batches', v_updated,
    'skipped_records', v_skipped_records
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_cancel_untouched_tally_sync_job_v1(uuid, uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_untouched_tally_sync_job_v1(uuid, uuid, text)
  TO authenticated;

COMMENT ON FUNCTION public.admin_cancel_untouched_tally_sync_job_v1(uuid, uuid, text) IS
  'Organization-admin cancellation for one untouched Tally sync job; preserves skipped batch audit rows and refuses any job with claimed/delivered/failed/manual-review batches.';
