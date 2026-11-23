-- Claim oldest batches by job creation time (not job_id UUID — that blocked the queue for months).

CREATE OR REPLACE FUNCTION public.connector_claim_delivery_batch_v1(
  p_connector_id uuid,
  p_lease_seconds integer DEFAULT 300,
  p_job_id uuid DEFAULT NULL,
  p_batch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_batch public.tally_sync_delivery_batches%ROWTYPE;
  v_company text;
BEGIN
  SELECT organization_id INTO v_org
  FROM public.tally_connector_devices
  WHERE id = p_connector_id AND revoked_at IS NULL AND is_enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'connector invalid' USING ERRCODE = '42501'; END IF;

  IF (p_job_id IS NULL) <> (p_batch_id IS NULL) THEN
    RAISE EXCEPTION 'job_id and batch_id must both be set or both omitted' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tally_sync_delivery_batches b
  SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL
  WHERE b.organization_id = v_org
    AND b.status = 'claimed'
    AND b.lease_expires_at IS NOT NULL
    AND b.lease_expires_at < now();

  IF p_batch_id IS NOT NULL THEN
    SELECT b.* INTO v_batch
    FROM public.tally_sync_delivery_batches b
    JOIN public.tally_sync_jobs j ON j.id = b.job_id
    WHERE b.id = p_batch_id
      AND b.job_id = p_job_id
      AND b.organization_id = v_org
      AND b.status = 'pending'
      AND j.status IN ('waiting_for_connector', 'delivering')
    FOR UPDATE;
  ELSE
    SELECT b.* INTO v_batch
    FROM public.tally_sync_delivery_batches b
    JOIN public.tally_sync_jobs j ON j.id = b.job_id
    WHERE b.organization_id = v_org
      AND b.status = 'pending'
      AND j.status IN ('waiting_for_connector', 'delivering')
    ORDER BY j.created_at DESC, b.batch_index ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  UPDATE public.tally_sync_delivery_batches
  SET status = 'claimed',
      claimed_by = p_connector_id,
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 60), 900)),
      attempt_count = attempt_count + 1,
      updated_at = now()
  WHERE id = v_batch.id;

  UPDATE public.tally_sync_jobs SET status = 'delivering' WHERE id = v_batch.job_id;

  SELECT tally_company_name INTO v_company
  FROM public.tally_org_connector_config WHERE organization_id = v_org;

  RETURN jsonb_build_object(
    'claimed', true,
    'batch_id', v_batch.id,
    'job_id', v_batch.job_id,
    'batch_index', v_batch.batch_index,
    'message_count', v_batch.message_count,
    'xml', v_batch.xml_payload,
    'delivery_updates', COALESCE(v_batch.delivery_updates, '[]'::jsonb),
    'tally_company_name', v_company
  );
END;
$$;
