-- Phase 5: Connector devices, delivery batches, post-prepared orchestration.

ALTER TABLE public.tally_sync_jobs
  DROP CONSTRAINT IF EXISTS tally_sync_jobs_status_check;

ALTER TABLE public.tally_sync_jobs
  ADD CONSTRAINT tally_sync_jobs_status_check
    CHECK (status IN (
      'queued', 'processing', 'prepared',
      'waiting_for_connector', 'delivering',
      'completed', 'failed'
    ));

ALTER TABLE public.tally_org_connector_config
  ADD COLUMN IF NOT EXISTS connector_id uuid;

CREATE TABLE IF NOT EXISTS public.tally_connector_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  device_name         text NOT NULL DEFAULT 'Connector',
  installation_id     text NOT NULL,
  token_hash          text NOT NULL,
  token_prefix        text NOT NULL,
  paired_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  connector_version   text,
  revoked_at          timestamptz,
  is_enabled          boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, installation_id)
);

CREATE INDEX IF NOT EXISTS tally_connector_devices_org_idx
  ON public.tally_connector_devices (organization_id);

CREATE UNIQUE INDEX IF NOT EXISTS tally_connector_devices_token_hash_idx
  ON public.tally_connector_devices (token_hash)
  WHERE revoked_at IS NULL AND is_enabled = true;

ALTER TABLE public.tally_connector_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY tally_connector_devices_admin_select_v1
  ON public.tally_connector_devices FOR SELECT TO authenticated
  USING (public.tally_sync_admin_can_view_v1(organization_id));

REVOKE ALL ON public.tally_connector_devices FROM PUBLIC;
GRANT SELECT ON public.tally_connector_devices TO authenticated;
GRANT ALL ON public.tally_connector_devices TO service_role;

CREATE TABLE IF NOT EXISTS public.tally_connector_pairing_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code_hash           text NOT NULL,
  code_prefix         text NOT NULL,
  created_by          uuid NOT NULL,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  consumed_device_id  uuid REFERENCES public.tally_connector_devices(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tally_connector_pairing_codes_org_idx
  ON public.tally_connector_pairing_codes (organization_id, expires_at DESC);

ALTER TABLE public.tally_connector_pairing_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tally_connector_pairing_codes_admin_select_v1
  ON public.tally_connector_pairing_codes FOR SELECT TO authenticated
  USING (public.tally_sync_admin_can_view_v1(organization_id));

REVOKE ALL ON public.tally_connector_pairing_codes FROM PUBLIC;
GRANT SELECT ON public.tally_connector_pairing_codes TO authenticated;
GRANT ALL ON public.tally_connector_pairing_codes TO service_role;

CREATE TABLE IF NOT EXISTS public.tally_sync_delivery_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid NOT NULL REFERENCES public.tally_sync_jobs(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  batch_index         integer NOT NULL,
  message_count       integer NOT NULL DEFAULT 0,
  xml_payload         text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'pending',
  attempt_count       integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 5,
  claimed_by          uuid REFERENCES public.tally_connector_devices(id),
  claimed_at          timestamptz,
  lease_expires_at    timestamptz,
  last_error_safe     text,
  tally_response_safe text,
  ack_summary         jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CONSTRAINT tally_sync_delivery_batches_status_check
    CHECK (status IN ('pending', 'claimed', 'delivered', 'failed', 'skipped')),
  CONSTRAINT tally_sync_delivery_batches_unique_idx
    UNIQUE (job_id, batch_index)
);

CREATE INDEX IF NOT EXISTS tally_sync_delivery_batches_claim_idx
  ON public.tally_sync_delivery_batches (organization_id, status, batch_index)
  WHERE status IN ('pending', 'claimed');

ALTER TABLE public.tally_sync_delivery_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY tally_sync_delivery_batches_admin_select_v1
  ON public.tally_sync_delivery_batches FOR SELECT TO authenticated
  USING (public.tally_sync_admin_can_view_v1(organization_id));

REVOKE ALL ON public.tally_sync_delivery_batches FROM PUBLIC;
GRANT SELECT ON public.tally_sync_delivery_batches TO authenticated;
GRANT ALL ON public.tally_sync_delivery_batches TO service_role;

-- Admin creates one-time pairing code (plaintext shown once to admin UI / ops).
CREATE OR REPLACE FUNCTION public.create_tally_connector_pairing_code_v1(
  p_organization_id uuid,
  p_ttl_minutes integer DEFAULT 15
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_hash text;
  v_prefix text;
BEGIN
  IF NOT public.tally_sync_admin_can_view_v1(p_organization_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_hash := encode(digest(v_code, 'sha256'), 'hex');
  v_prefix := substr(v_code, 1, 4);
  INSERT INTO public.tally_connector_pairing_codes (organization_id, code_hash, code_prefix, created_by, expires_at)
  VALUES (p_organization_id, v_hash, v_prefix, auth.uid(), now() + make_interval(mins => LEAST(GREATEST(p_ttl_minutes, 5), 60)));
  RETURN jsonb_build_object('pairing_code', v_code, 'expires_in_minutes', LEAST(GREATEST(p_ttl_minutes, 5), 60));
END;
$$;

REVOKE ALL ON FUNCTION public.create_tally_connector_pairing_code_v1(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_tally_connector_pairing_code_v1(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.exchange_tally_connector_pairing_v1(
  p_pairing_code text,
  p_device_name text,
  p_installation_id text,
  p_connector_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.tally_connector_pairing_codes%ROWTYPE;
  v_token text;
  v_hash text;
  v_prefix text;
  v_device_id uuid;
BEGIN
  IF p_installation_id IS NULL OR length(trim(p_installation_id)) < 8 THEN
    RAISE EXCEPTION 'installation_id required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row
  FROM public.tally_connector_pairing_codes
  WHERE code_hash = encode(digest(upper(trim(p_pairing_code)), 'sha256'), 'hex')
    AND consumed_at IS NULL
    AND expires_at > now()
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid or expired pairing code' USING ERRCODE = '22023';
  END IF;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_hash := encode(digest(v_token, 'sha256'), 'hex');
  v_prefix := substr(v_token, 1, 8);
  INSERT INTO public.tally_connector_devices (
    organization_id, device_name, installation_id, token_hash, token_prefix, connector_version
  ) VALUES (
    v_row.organization_id, COALESCE(NULLIF(trim(p_device_name), ''), 'Connector'),
    trim(p_installation_id), v_hash, v_prefix, p_connector_version
  )
  ON CONFLICT (organization_id, installation_id) DO UPDATE
  SET device_name = EXCLUDED.device_name,
      token_hash = EXCLUDED.token_hash,
      token_prefix = EXCLUDED.token_prefix,
      connector_version = EXCLUDED.connector_version,
      revoked_at = NULL,
      is_enabled = true,
      paired_at = now()
  RETURNING id INTO v_device_id;

  UPDATE public.tally_connector_pairing_codes
  SET consumed_at = now(), consumed_device_id = v_device_id
  WHERE id = v_row.id;

  UPDATE public.tally_org_connector_config
  SET connector_device_id = v_device_id::text,
      connector_id = v_device_id,
      is_active = true,
      updated_at = now()
  WHERE organization_id = v_row.organization_id;

  INSERT INTO public.tally_org_connector_config (organization_id, connector_id, connector_device_id, is_active)
  VALUES (v_row.organization_id, v_device_id, v_device_id::text, true)
  ON CONFLICT (organization_id) DO UPDATE
  SET connector_id = EXCLUDED.connector_id,
      connector_device_id = EXCLUDED.connector_device_id,
      is_active = true,
      updated_at = now();

  RETURN jsonb_build_object(
    'connector_id', v_device_id,
    'organization_id', v_row.organization_id,
    'device_token', v_token
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exchange_tally_connector_pairing_v1(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exchange_tally_connector_pairing_v1(text, text, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.resolve_tally_connector_device_v1(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dev public.tally_connector_devices%ROWTYPE;
BEGIN
  IF p_bearer_token IS NULL OR length(p_bearer_token) < 32 THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_dev
  FROM public.tally_connector_devices
  WHERE token_hash = encode(digest(p_bearer_token, 'sha256'), 'hex')
    AND revoked_at IS NULL
    AND is_enabled = true
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'connector_id', v_dev.id,
    'organization_id', v_dev.organization_id,
    'device_name', v_dev.device_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_tally_connector_device_v1(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_tally_connector_device_v1(text) TO service_role;

CREATE OR REPLACE FUNCTION public.connector_heartbeat_v1(
  p_connector_id uuid,
  p_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.tally_connector_devices
  SET last_seen_at = now(),
      connector_version = COALESCE(p_version, connector_version)
  WHERE id = p_connector_id AND revoked_at IS NULL AND is_enabled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connector revoked or unknown' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.connector_heartbeat_v1(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.connector_heartbeat_v1(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.revoke_tally_connector_v1(p_connector_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.tally_connector_devices WHERE id = p_connector_id;
  IF NOT FOUND OR NOT public.tally_sync_admin_can_view_v1(v_org) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  UPDATE public.tally_connector_devices
  SET revoked_at = now(), is_enabled = false
  WHERE id = p_connector_id;
  UPDATE public.tally_org_connector_config
  SET is_active = false, updated_at = now()
  WHERE organization_id = v_org;
  RETURN jsonb_build_object('revoked', true);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_tally_connector_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_tally_connector_v1(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.store_tally_delivery_batches_v1(
  p_job_id uuid,
  p_batches jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.tally_sync_jobs%ROWTYPE;
  v_batch jsonb;
  v_n integer := 0;
BEGIN
  SELECT * INTO v_job FROM public.tally_sync_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job not found' USING ERRCODE = '22023'; END IF;
  IF v_job.status NOT IN ('prepared', 'waiting_for_connector') THEN
    RAISE EXCEPTION 'job not ready for delivery enqueue: %', v_job.status USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.tally_sync_delivery_batches WHERE job_id = p_job_id AND status = 'pending';
  FOR v_batch IN SELECT * FROM jsonb_array_elements(COALESCE(p_batches, '[]'::jsonb))
  LOOP
    INSERT INTO public.tally_sync_delivery_batches (
      job_id, organization_id, batch_index, message_count, xml_payload, status
    ) VALUES (
      p_job_id,
      v_job.organization_id,
      (v_batch->>'batch_index')::integer,
      COALESCE((v_batch->>'message_count')::integer, 0),
      COALESCE(v_batch->>'xml', ''),
      CASE WHEN COALESCE((v_batch->>'message_count')::integer, 0) = 0 THEN 'skipped' ELSE 'pending' END
    )
    ON CONFLICT (job_id, batch_index) DO UPDATE
    SET message_count = EXCLUDED.message_count,
        xml_payload = EXCLUDED.xml_payload,
        status = EXCLUDED.status,
        updated_at = now();
    v_n := v_n + 1;
  END LOOP;
  UPDATE public.tally_sync_jobs
  SET status = CASE WHEN v_n = 0 OR NOT EXISTS (
        SELECT 1 FROM public.tally_sync_delivery_batches b
        WHERE b.job_id = p_job_id AND b.status = 'pending'
      ) THEN 'completed'
      ELSE 'waiting_for_connector' END,
      completed_at = CASE WHEN v_n = 0 OR NOT EXISTS (
        SELECT 1 FROM public.tally_sync_delivery_batches b WHERE b.job_id = p_job_id AND b.status = 'pending'
      ) THEN now() ELSE completed_at END
  WHERE id = p_job_id;
  RETURN jsonb_build_object('batches', v_n, 'job_status', (SELECT status FROM public.tally_sync_jobs WHERE id = p_job_id));
END;
$$;

REVOKE ALL ON FUNCTION public.store_tally_delivery_batches_v1(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_tally_delivery_batches_v1(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.connector_claim_delivery_batch_v1(
  p_connector_id uuid,
  p_lease_seconds integer DEFAULT 300
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

  UPDATE public.tally_sync_delivery_batches b
  SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL
  WHERE b.organization_id = v_org
    AND b.status = 'claimed'
    AND b.lease_expires_at IS NOT NULL
    AND b.lease_expires_at < now();

  SELECT b.* INTO v_batch
  FROM public.tally_sync_delivery_batches b
  JOIN public.tally_sync_jobs j ON j.id = b.job_id
  WHERE b.organization_id = v_org
    AND b.status = 'pending'
    AND j.status IN ('waiting_for_connector', 'delivering')
  ORDER BY b.job_id, b.batch_index
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

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
    'tally_company_name', v_company
  );
END;
$$;

REVOKE ALL ON FUNCTION public.connector_claim_delivery_batch_v1(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.connector_claim_delivery_batch_v1(uuid, integer) TO service_role;

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
    SET status = CASE WHEN v_batch.attempt_count >= v_batch.max_attempts THEN 'failed' ELSE 'pending' END,
        claimed_by = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL,
        last_error_safe = left(COALESCE(p_error_safe, 'delivery failed'), 500),
        tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
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

REVOKE ALL ON FUNCTION public.connector_ack_delivery_batch_v1(uuid, uuid, boolean, jsonb, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.connector_ack_delivery_batch_v1(uuid, uuid, boolean, jsonb, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.set_tally_org_company_v1(
  p_organization_id uuid,
  p_tally_company_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.tally_sync_admin_can_view_v1(p_organization_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.tally_org_connector_config (organization_id, tally_company_name, is_active)
  VALUES (p_organization_id, trim(p_tally_company_name), true)
  ON CONFLICT (organization_id) DO UPDATE
  SET tally_company_name = EXCLUDED.tally_company_name, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_tally_org_company_v1(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_tally_org_company_v1(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.load_tally_sync_job_items_v1(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'seq', i.seq,
    'source_type', i.source_type,
    'source_key', i.source_key,
    'content_hash', i.content_hash,
    'payload', i.payload
  ) ORDER BY i.seq), '[]'::jsonb)
  FROM public.tally_sync_job_items i
  WHERE i.job_id = p_job_id;
$$;

REVOKE ALL ON FUNCTION public.load_tally_sync_job_items_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_tally_sync_job_items_v1(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.load_tally_delivery_state_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'organization_id', d.organization_id,
    'delivery_key', d.delivery_key,
    'delivery_kind', d.delivery_kind,
    'last_content_hash', d.last_content_hash,
    'tally_remote_id', d.tally_remote_id,
    'last_action', d.last_action,
    'last_job_id', d.last_job_id,
    'peso_deleted_at', d.peso_deleted_at,
    'cancel_strategy', d.cancel_strategy
  )), '[]'::jsonb)
  FROM public.tally_delivery_state d
  WHERE d.organization_id = p_organization_id;
$$;

REVOKE ALL ON FUNCTION public.load_tally_delivery_state_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_tally_delivery_state_v1(uuid) TO service_role;
