-- Controlled E2E: bound claim + manual_review (no auto-retry) + optional job/batch targeting.

ALTER TABLE public.tally_sync_delivery_batches
  DROP CONSTRAINT IF EXISTS tally_sync_delivery_batches_status_check;

ALTER TABLE public.tally_sync_delivery_batches
  ADD CONSTRAINT tally_sync_delivery_batches_status_check
  CHECK (status IN ('pending', 'claimed', 'delivered', 'failed', 'skipped', 'manual_review'));

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
    AND b.lease_expires_at < now()
    AND (p_batch_id IS NULL OR b.id <> p_batch_id);

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
    ORDER BY b.job_id, b.batch_index
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

CREATE OR REPLACE FUNCTION public.connector_ack_delivery_batch_v1(
  p_connector_id uuid,
  p_batch_id uuid,
  p_success boolean,
  p_ack_summary jsonb DEFAULT '{}'::jsonb,
  p_tally_response_safe text DEFAULT NULL,
  p_error_safe text DEFAULT NULL,
  p_delivery_updates jsonb DEFAULT '[]'::jsonb,
  p_e2e_hold boolean DEFAULT false
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
  v_state public.tally_delivery_state%ROWTYPE;
  v_expected integer;
  v_claimed_rev integer;
  v_new_hash text;
  v_kind text;
BEGIN
  SELECT organization_id INTO v_org FROM public.tally_connector_devices
  WHERE id = p_connector_id AND revoked_at IS NULL AND is_enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'connector invalid' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_batch FROM public.tally_sync_delivery_batches
  WHERE id = p_batch_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch not found' USING ERRCODE = '22023'; END IF;
  IF v_batch.claimed_by IS DISTINCT FROM p_connector_id THEN
    RAISE EXCEPTION 'batch not claimed by connector' USING ERRCODE = '42501';
  END IF;

  IF p_success THEN
    FOR v_up IN SELECT * FROM jsonb_array_elements(
      CASE WHEN jsonb_array_length(COALESCE(p_delivery_updates, '[]'::jsonb)) > 0
        THEN p_delivery_updates
        ELSE COALESCE(v_batch.delivery_updates, '[]'::jsonb)
      END
    )
    LOOP
      v_new_hash := NULLIF(v_up->>'content_hash', '');
      v_kind := COALESCE(v_up->>'delivery_kind', 'report_metadata');
      v_claimed_rev := NULLIF(v_up->>'metadata_revision', '')::integer;

      SELECT * INTO v_state FROM public.tally_delivery_state
      WHERE organization_id = v_org AND delivery_key = v_up->>'delivery_key'
      FOR UPDATE;

      IF NOT FOUND THEN
        v_expected := public.tally_expected_metadata_revision_v1(NULL, NULL, v_new_hash);
      ELSE
        v_expected := public.tally_expected_metadata_revision_v1(
          v_state.last_content_hash, v_state.last_metadata_revision, v_new_hash
        );
      END IF;

      IF v_kind = 'report_metadata' AND v_new_hash IS NOT NULL THEN
        IF v_claimed_rev IS NOT NULL AND v_claimed_rev <> v_expected THEN
          IF p_e2e_hold THEN
            UPDATE public.tally_sync_delivery_batches
            SET status = 'manual_review',
                claimed_by = NULL,
                claimed_at = NULL,
                lease_expires_at = NULL,
                last_error_safe = left(
                  format('metadata_revision mismatch expected %s got %s', v_expected, v_claimed_rev),
                  500
                ),
                updated_at = now()
            WHERE id = p_batch_id;
            UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector' WHERE id = v_batch.job_id;
            RETURN jsonb_build_object('ok', false, 'error', 'metadata_revision_mismatch', 'batch_status', 'manual_review');
          END IF;
          UPDATE public.tally_sync_delivery_batches
          SET status = 'pending',
              claimed_by = NULL,
              claimed_at = NULL,
              lease_expires_at = NULL,
              last_error_safe = left(
                format('metadata_revision mismatch expected %s got %s', v_expected, v_claimed_rev),
                500
              ),
              updated_at = now()
          WHERE id = p_batch_id;
          UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector' WHERE id = v_batch.job_id;
          RETURN jsonb_build_object(
            'ok', false,
            'error', 'metadata_revision_mismatch',
            'expected', v_expected,
            'claimed', v_claimed_rev
          );
        END IF;
      END IF;

      INSERT INTO public.tally_delivery_state (
        organization_id, delivery_key, delivery_kind, last_content_hash,
        last_metadata_revision, tally_remote_id, last_action, last_job_id, updated_at
      ) VALUES (
        v_org,
        v_up->>'delivery_key',
        v_kind,
        v_new_hash,
        CASE WHEN v_kind = 'report_metadata' THEN COALESCE(v_claimed_rev, v_expected) ELSE NULL END,
        NULLIF(v_up->>'tally_remote_id', ''),
        COALESCE(v_up->>'last_action', 'create'),
        v_batch.job_id,
        now()
      )
      ON CONFLICT (organization_id, delivery_key) DO UPDATE
      SET last_content_hash = EXCLUDED.last_content_hash,
          last_metadata_revision = CASE
            WHEN EXCLUDED.delivery_kind = 'report_metadata' THEN EXCLUDED.last_metadata_revision
            ELSE tally_delivery_state.last_metadata_revision
          END,
          tally_remote_id = COALESCE(EXCLUDED.tally_remote_id, tally_delivery_state.tally_remote_id),
          last_action = EXCLUDED.last_action,
          last_job_id = EXCLUDED.last_job_id,
          updated_at = now();
    END LOOP;

    UPDATE public.tally_sync_delivery_batches
    SET status = 'delivered',
        ack_summary = p_ack_summary,
        tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
        completed_at = now(),
        updated_at = now()
    WHERE id = p_batch_id;
  ELSE
    IF p_e2e_hold THEN
      UPDATE public.tally_sync_delivery_batches
      SET status = 'manual_review',
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_error_safe = left(COALESCE(p_error_safe, 'e2e delivery failed or ambiguous'), 500),
          tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
          ack_summary = COALESCE(p_ack_summary, '{}'::jsonb) || jsonb_build_object('e2e_hold', true),
          updated_at = now()
      WHERE id = p_batch_id;
    ELSE
      UPDATE public.tally_sync_delivery_batches
      SET status = CASE WHEN v_batch.attempt_count >= v_batch.max_attempts THEN 'failed' ELSE 'pending' END,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_error_safe = left(COALESCE(p_error_safe, 'delivery failed'), 500),
          tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
          updated_at = now()
      WHERE id = p_batch_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_pending
  FROM public.tally_sync_delivery_batches
  WHERE job_id = v_batch.job_id AND status IN ('pending', 'claimed');

  IF v_pending = 0 AND NOT EXISTS (
    SELECT 1 FROM public.tally_sync_delivery_batches
    WHERE job_id = v_batch.job_id AND status = 'failed'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.tally_sync_delivery_batches
    WHERE job_id = v_batch.job_id AND status = 'manual_review'
  ) THEN
    UPDATE public.tally_sync_jobs
    SET status = 'completed', completed_at = now()
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
    UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector' WHERE id = v_batch.job_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'job_id', v_batch.job_id,
    'batch_status', (SELECT status FROM public.tally_sync_delivery_batches WHERE id = p_batch_id)
  );
END;
$$;
