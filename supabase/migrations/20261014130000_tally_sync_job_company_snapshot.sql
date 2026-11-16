-- Freeze the Tally destination when the admin creates a sync job.
-- Existing jobs intentionally remain NULL and cannot be claimed automatically:
-- their intended company cannot be reconstructed safely after the fact.

ALTER TABLE public.tally_sync_jobs
  ADD COLUMN IF NOT EXISTS tally_company_name text;

COMMENT ON COLUMN public.tally_sync_jobs.tally_company_name IS
  'Company destination frozen at job creation. NULL means legacy/unknown and the connector must not claim it.';

CREATE OR REPLACE FUNCTION public.create_tally_sync_job_v1(
  p_organization_id uuid,
  p_report_type     text,
  p_parameters      jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_params   jsonb := COALESCE(p_parameters, '{}'::jsonb);
  v_config   jsonb := NULL;
  v_company  text;
  v_dedupe   text;
  v_existing public.tally_sync_jobs%ROWTYPE;
  v_job_id   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_report_type NOT IN (
    'claim_verification', 'claim_approval', 'detailed_expense', 'daily_project_report'
  ) THEN
    RAISE EXCEPTION 'unsupported report type' USING ERRCODE = '22023';
  END IF;
  IF NOT public.tally_sync_admin_can_view_v1(p_organization_id) THEN
    RAISE EXCEPTION 'not permitted to create tally sync jobs' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_params) <> 'object' THEN
    RAISE EXCEPTION 'parameters must be a json object' USING ERRCODE = '22023';
  END IF;

  SELECT NULLIF(btrim(c.tally_company_name), '') INTO v_company
  FROM public.tally_org_connector_config c
  WHERE c.organization_id = p_organization_id AND c.is_active = true;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Tally company is not configured for this organization' USING ERRCODE = '22023';
  END IF;

  IF p_report_type = 'daily_project_report' THEN
    SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) INTO v_config
    FROM public.organization_settings s
    WHERE s.organization_id = p_organization_id;
    v_config := COALESCE(v_config, '{}'::jsonb);
  END IF;

  -- The destination is part of idempotency. Identical report filters sent to two
  -- authorized companies represent different jobs and must never collapse together.
  v_dedupe := md5(
    p_organization_id::text || '|' || p_report_type || '|' || v_params::text ||
    COALESCE('|' || v_config::text, '') || '|' || v_company
  );

  SELECT * INTO v_existing
  FROM public.tally_sync_jobs
  WHERE dedupe_key = v_dedupe AND status IN ('queued', 'processing')
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'job_id', v_existing.id,
      'status', v_existing.status,
      'deduplicated', true
    );
  END IF;

  INSERT INTO public.tally_sync_jobs (
    organization_id, requested_by, report_type, parameters, config_snapshot,
    tally_company_name, dedupe_key, status
  ) VALUES (
    p_organization_id, v_uid, p_report_type, v_params, v_config,
    v_company, v_dedupe, 'queued'
  )
  RETURNING id INTO v_job_id;

  RETURN jsonb_build_object(
    'job_id', v_job_id,
    'status', 'queued',
    'deduplicated', false
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM public.tally_sync_jobs
    WHERE dedupe_key = v_dedupe AND status IN ('queued', 'processing')
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'job_id', v_existing.id,
        'status', v_existing.status,
        'deduplicated', true
      );
    END IF;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.create_tally_sync_job_v1(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_tally_sync_job_v1(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_tally_sync_job_v1(uuid, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.connector_claim_delivery_batch_v1(
  p_connector_id uuid,
  p_lease_seconds integer DEFAULT 300,
  p_job_id uuid DEFAULT NULL,
  p_batch_id uuid DEFAULT NULL,
  p_expected_company_name text DEFAULT NULL
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
  WHERE id = p_connector_id AND revoked_at IS NULL AND is_enabled = true
    AND connector_version = '0.6.0-company-verify';
  IF NOT FOUND THEN RAISE EXCEPTION 'connector invalid or unsupported version' USING ERRCODE = '42501'; END IF;

  IF (p_job_id IS NULL) <> (p_batch_id IS NULL) THEN
    RAISE EXCEPTION 'job_id and batch_id must both be set or both omitted' USING ERRCODE = '22023';
  END IF;
  IF p_expected_company_name IS NULL OR btrim(p_expected_company_name) = '' THEN
    RAISE EXCEPTION 'active Tally company is required' USING ERRCODE = '22023';
  END IF;

  -- Expired leases are ambiguous; do not replay their imports.
  WITH expired AS (
    UPDATE public.tally_sync_delivery_batches b
    SET status = 'manual_review',
        last_error_safe = COALESCE(b.last_error_safe, 'Delivery lease expired; reconcile Tally before retry'),
        updated_at = now()
    WHERE b.organization_id = v_org
      AND b.status = 'claimed'
      AND b.lease_expires_at IS NOT NULL
      AND b.lease_expires_at <= now()
    RETURNING b.job_id
  )
  UPDATE public.tally_sync_jobs j
  SET status = 'waiting_for_connector', error_code = 'tally_manual_review',
      error_message_safe = 'A delivery lease expired and needs manual reconciliation'
  WHERE j.id IN (SELECT DISTINCT job_id FROM expired) AND j.status <> 'completed';

  IF p_batch_id IS NOT NULL THEN
    SELECT b.* INTO v_batch
    FROM public.tally_sync_delivery_batches b
    JOIN public.tally_sync_jobs j ON j.id = b.job_id AND j.organization_id = b.organization_id
    WHERE b.id = p_batch_id
      AND b.job_id = p_job_id
      AND b.organization_id = v_org
      AND j.tally_company_name = btrim(p_expected_company_name)
      AND b.status = 'pending'
      AND j.status IN ('waiting_for_connector', 'delivering')
      AND NOT EXISTS (
        SELECT 1 FROM public.tally_sync_delivery_batches prior
        WHERE prior.job_id = b.job_id AND prior.batch_index < b.batch_index
          AND prior.status NOT IN ('delivered', 'skipped')
      )
    FOR UPDATE OF b;
  ELSE
    SELECT b.* INTO v_batch
    FROM public.tally_sync_delivery_batches b
    JOIN public.tally_sync_jobs j ON j.id = b.job_id AND j.organization_id = b.organization_id
    WHERE b.organization_id = v_org
      AND j.tally_company_name = btrim(p_expected_company_name)
      AND b.status = 'pending'
      AND j.status IN ('waiting_for_connector', 'delivering')
      AND NOT EXISTS (
        SELECT 1 FROM public.tally_sync_delivery_batches prior
        WHERE prior.job_id = b.job_id AND prior.batch_index < b.batch_index
          AND prior.status NOT IN ('delivered', 'skipped')
      )
    ORDER BY j.created_at ASC, b.batch_index ASC
    LIMIT 1
    FOR UPDATE OF b SKIP LOCKED;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  SELECT j.tally_company_name INTO v_company
  FROM public.tally_sync_jobs j
  WHERE j.id = v_batch.job_id AND j.organization_id = v_org;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'sync job has no frozen Tally company; manual reconciliation required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tally_sync_delivery_batches
  SET status = 'claimed', claimed_by = p_connector_id, claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 60), 900)),
      attempt_count = attempt_count + 1, updated_at = now()
  WHERE id = v_batch.id;

  UPDATE public.tally_sync_jobs SET status = 'delivering'
  WHERE id = v_batch.job_id AND status IN ('waiting_for_connector', 'delivering');

  RETURN jsonb_build_object(
    'claimed', true, 'batch_id', v_batch.id, 'job_id', v_batch.job_id,
    'batch_index', v_batch.batch_index, 'message_count', v_batch.message_count,
    'xml', v_batch.xml_payload, 'delivery_updates', COALESCE(v_batch.delivery_updates, '[]'::jsonb),
    'tally_company_name', v_company
  );
END;
$$;

REVOKE ALL ON FUNCTION public.connector_claim_delivery_batch_v1(uuid, integer, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_claim_delivery_batch_v1(uuid, integer, uuid, uuid, text) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.tally_sync_jobs'::regclass
      AND attname = 'tally_company_name' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Tally company snapshot column missing';
  END IF;
  IF has_function_privilege('anon', 'public.create_tally_sync_job_v1(uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute create_tally_sync_job_v1';
  END IF;
  IF has_function_privilege('authenticated', 'public.connector_claim_delivery_batch_v1(uuid, integer, uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not execute connector_claim_delivery_batch_v1';
  END IF;
END;
$$;
