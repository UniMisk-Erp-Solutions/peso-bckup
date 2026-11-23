-- Duplicate-only delivery (no UDF refresh) must retry forever — never fail job on that alone.

CREATE OR REPLACE FUNCTION public.connector_ack_delivery_batch_v1(
  p_connector_id uuid,
  p_batch_id uuid,
  p_success boolean,
  p_ack_summary jsonb DEFAULT '{}'::jsonb,
  p_tally_response_safe text DEFAULT NULL,
  p_error_safe text DEFAULT NULL,
  p_delivery_updates jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch public.tally_sync_delivery_batches%ROWTYPE;
  v_org uuid;
  v_pending integer;
  v_up jsonb;
  v_dup_only boolean;
BEGIN
  SELECT organization_id INTO v_org FROM public.tally_connector_devices
  WHERE id = p_connector_id AND revoked_at IS NULL AND is_enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'connector invalid' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_batch FROM public.tally_sync_delivery_batches
  WHERE id = p_batch_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch not found' USING ERRCODE = '22023'; END IF;
  IF v_batch.claimed_by IS DISTINCT FROM p_connector_id THEN
    RAISE EXCEPTION 'batch not claimed by connector' USING ERRCODE = '42501'; END IF;

  v_dup_only := COALESCE((p_ack_summary->>'duplicate_only')::boolean, false)
    OR COALESCE(p_error_safe, '') ILIKE '%duplicate%'
    OR COALESCE(p_error_safe, '') ILIKE '%udf%';

  IF p_success THEN
    UPDATE public.tally_sync_delivery_batches
    SET status = 'delivered',
        ack_summary = p_ack_summary,
        tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
        completed_at = now(),
        updated_at = now()
    WHERE id = p_batch_id;

    FOR v_up IN SELECT * FROM jsonb_array_elements(COALESCE(p_delivery_updates, '[]'::jsonb))
    LOOP
      INSERT INTO public.tally_delivery_state (
        organization_id, delivery_key, delivery_kind, last_content_hash,
        tally_remote_id, last_action, last_job_id, updated_at
      ) VALUES (
        v_org,
        v_up->>'delivery_key',
        COALESCE(v_up->>'delivery_kind', 'report_metadata'),
        v_up->>'content_hash',
        NULLIF(v_up->>'tally_remote_id', ''),
        COALESCE(v_up->>'last_action', 'create'),
        v_batch.job_id,
        now()
      )
      ON CONFLICT (organization_id, delivery_key) DO UPDATE
      SET last_content_hash = EXCLUDED.last_content_hash,
          tally_remote_id = COALESCE(EXCLUDED.tally_remote_id, tally_delivery_state.tally_remote_id),
          last_action = EXCLUDED.last_action,
          last_job_id = EXCLUDED.last_job_id,
          updated_at = now();
    END LOOP;
  ELSE
    UPDATE public.tally_sync_delivery_batches
    SET status = CASE
          WHEN v_dup_only THEN 'pending'
          WHEN v_batch.attempt_count >= v_batch.max_attempts THEN 'failed'
          ELSE 'pending'
        END,
        attempt_count = CASE WHEN v_dup_only THEN GREATEST(v_batch.attempt_count - 1, 0) ELSE v_batch.attempt_count END,
        claimed_by = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL,
        last_error_safe = left(COALESCE(p_error_safe, 'delivery failed'), 500),
        tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
        ack_summary = p_ack_summary,
        updated_at = now()
    WHERE id = p_batch_id;
  END IF;

  SELECT count(*) INTO v_pending
  FROM public.tally_sync_delivery_batches
  WHERE job_id = v_batch.job_id AND status IN ('pending', 'claimed');

  IF v_pending = 0 AND NOT EXISTS (
    SELECT 1 FROM public.tally_sync_delivery_batches
    WHERE job_id = v_batch.job_id AND status = 'failed'
  ) THEN
    UPDATE public.tally_sync_jobs
    SET status = 'completed', completed_at = now(), error_code = NULL, error_message_safe = NULL
    WHERE id = v_batch.job_id;
  ELSIF EXISTS (
    SELECT 1 FROM public.tally_sync_delivery_batches
    WHERE job_id = v_batch.job_id AND status = 'failed'
  ) THEN
    UPDATE public.tally_sync_jobs
    SET status = 'failed',
        error_code = 'tally_delivery_failed',
        error_message_safe = 'One or more Tally delivery batches failed'
    WHERE id = v_batch.job_id AND status <> 'completed';
  ELSE
    UPDATE public.tally_sync_jobs
    SET status = 'waiting_for_connector', error_code = NULL, error_message_safe = NULL
    WHERE id = v_batch.job_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'job_id', v_batch.job_id,
    'batch_status', (SELECT status FROM public.tally_sync_delivery_batches WHERE id = p_batch_id)
  );
END;
$$;
