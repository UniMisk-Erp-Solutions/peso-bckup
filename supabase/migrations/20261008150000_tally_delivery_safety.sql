-- Tally delivery safety correction.
-- Uncertain imports are quarantined for explicit admin reconciliation; they are never replayed.

-- Remove older callable overloads before installing the defaulted five-argument signature.
DROP FUNCTION IF EXISTS public.connector_claim_delivery_batch_v1(uuid, integer);
DROP FUNCTION IF EXISTS public.connector_claim_delivery_batch_v1(uuid, integer, uuid, uuid);

ALTER TABLE public.tally_sync_delivery_batches
  DROP CONSTRAINT IF EXISTS tally_sync_delivery_batches_status_check;
ALTER TABLE public.tally_sync_delivery_batches
  ADD CONSTRAINT tally_sync_delivery_batches_status_check
  CHECK (status IN ('pending', 'claimed', 'delivered', 'failed', 'skipped', 'manual_review'));

-- Existing pending/claimed batches predate the verified-company release. Their Tally outcome
-- cannot be inferred safely, so quarantine them at rollout instead of auto-importing/replaying.
WITH legacy AS (
  UPDATE public.tally_sync_delivery_batches b
  SET status = 'manual_review',
      last_error_safe = COALESCE(b.last_error_safe, 'Pre-verification delivery quarantined during safety rollout'),
      updated_at = now()
  WHERE b.status IN ('pending', 'claimed')
  RETURNING b.job_id
)
UPDATE public.tally_sync_jobs j
SET status = 'waiting_for_connector', completed_at = NULL,
    error_code = 'tally_manual_review',
    error_message_safe = 'Pre-verification deliveries need manual reconciliation'
WHERE j.id IN (SELECT DISTINCT job_id FROM legacy);

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

  SELECT tally_company_name INTO v_company
  FROM public.tally_org_connector_config WHERE organization_id = v_org;
  IF p_expected_company_name IS NULL OR btrim(p_expected_company_name) = ''
     OR v_company IS DISTINCT FROM btrim(p_expected_company_name) THEN
    RAISE EXCEPTION 'connector and organization Tally company configuration mismatch' USING ERRCODE = '22023';
  END IF;

  -- Serialize expiry and claim transitions. Expiry means outcome unknown, never retryable.
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

  IF NOT FOUND THEN RETURN jsonb_build_object('claimed', false); END IF;

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

-- The old 8-argument overload accepted a caller-controlled e2e_hold switch. The Edge Function
-- now calls the 7-argument function below; fail this migration if an unexpected SQL dependency exists.
DROP FUNCTION IF EXISTS public.connector_ack_delivery_batch_v1(uuid, uuid, boolean, jsonb, text, text, jsonb, boolean);

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
  v_up jsonb;
  v_state public.tally_delivery_state%ROWTYPE;
  v_expected integer;
  v_claimed_rev integer;
  v_new_hash text;
  v_kind text;
  v_key text;
  v_updates jsonb;
BEGIN
  SELECT organization_id INTO v_org FROM public.tally_connector_devices
  WHERE id = p_connector_id AND revoked_at IS NULL AND is_enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'connector invalid' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_batch FROM public.tally_sync_delivery_batches
  WHERE id = p_batch_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch not found' USING ERRCODE = '22023'; END IF;
  IF v_batch.status <> 'claimed' OR v_batch.claimed_by IS DISTINCT FROM p_connector_id
     OR v_batch.lease_expires_at IS NULL OR v_batch.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'batch claim is stale, expired, or not owned by connector' USING ERRCODE = '42501';
  END IF;

  -- Trust only the delivery plan frozen with the batch. Client-supplied metadata must match it.
  v_updates := COALESCE(v_batch.delivery_updates, '[]'::jsonb);
  IF jsonb_typeof(v_updates) <> 'array' OR jsonb_typeof(COALESCE(p_delivery_updates, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'delivery updates must be arrays' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_delivery_updates, '[]'::jsonb) <> '[]'::jsonb
     AND p_delivery_updates <> v_updates THEN
    RAISE EXCEPTION 'delivery updates differ from frozen batch plan' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_updates)) <>
     (SELECT count(DISTINCT value->>'delivery_key') FROM jsonb_array_elements(v_updates)) THEN
    RAISE EXCEPTION 'duplicate delivery key in frozen batch plan' USING ERRCODE = '22023';
  END IF;

  IF p_success IS DISTINCT FROM TRUE THEN
    UPDATE public.tally_sync_delivery_batches
    SET status = 'manual_review',
        last_error_safe = left(COALESCE(NULLIF(p_error_safe, ''), 'Tally outcome is uncertain; reconcile before retry'), 500),
        tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
        ack_summary = COALESCE(p_ack_summary, '{}'::jsonb), updated_at = now()
    WHERE id = p_batch_id;
    UPDATE public.tally_sync_jobs
    SET status = 'waiting_for_connector', error_code = 'tally_manual_review',
        error_message_safe = 'A delivery needs manual reconciliation before processing can continue'
    WHERE id = v_batch.job_id AND status <> 'completed';
    RETURN jsonb_build_object('ok', true, 'job_id', v_batch.job_id, 'batch_status', 'manual_review');
  END IF;

  IF v_batch.message_count > 0 AND (
    jsonb_typeof(COALESCE(p_ack_summary, '{}'::jsonb)) <> 'object'
    OR jsonb_typeof(p_ack_summary->'created') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_ack_summary->'altered') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_ack_summary->'deleted') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_ack_summary->'ignored') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_ack_summary->'exceptions') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_ack_summary->'errors') IS DISTINCT FROM 'array'
    OR COALESCE((p_ack_summary->>'created')::integer, 0)
       + COALESCE((p_ack_summary->>'altered')::integer, 0)
       + COALESCE((p_ack_summary->>'deleted')::integer, 0) = 0
    OR COALESCE((p_ack_summary->>'ignored')::integer, 0) <> 0
    OR COALESCE((p_ack_summary->>'exceptions')::integer, 0) <> 0
    OR COALESCE(jsonb_array_length(p_ack_summary->'errors'), -1) <> 0
  ) THEN
    RAISE EXCEPTION 'successful acknowledgment lacks a complete clean Tally import summary' USING ERRCODE = '22023';
  END IF;

  -- Lock existing and absent delivery keys consistently, then validate the whole batch before writes.
  FOR v_key IN
    SELECT DISTINCT x->>'delivery_key' FROM jsonb_array_elements(v_updates) x
    ORDER BY 1
  LOOP
    IF v_key IS NULL OR length(v_key) = 0 OR length(v_key) > 500 THEN
      RAISE EXCEPTION 'invalid delivery key in frozen batch' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_key, 0));
  END LOOP;

  FOR v_up IN SELECT value FROM jsonb_array_elements(v_updates)
  LOOP
    v_key := v_up->>'delivery_key';
    v_new_hash := NULLIF(v_up->>'content_hash', '');
    v_kind := COALESCE(v_up->>'delivery_kind', 'report_metadata');
    IF v_key IS NULL OR v_new_hash IS NULL OR v_kind NOT IN
       ('accounting_expense', 'accounting_balance_event', 'report_metadata', 'daily_metadata') THEN
      RAISE EXCEPTION 'invalid frozen delivery metadata' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_up->>'last_action', 'create') NOT IN ('pending', 'create', 'skip', 'update', 'cancel_planned') THEN
      RAISE EXCEPTION 'invalid delivery action' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_state FROM public.tally_delivery_state
    WHERE organization_id = v_org AND delivery_key = v_key FOR UPDATE;
    IF FOUND THEN
      v_expected := public.tally_expected_metadata_revision_v1(
        v_state.last_content_hash, v_state.last_metadata_revision, v_new_hash
      );
    ELSE
      v_expected := public.tally_expected_metadata_revision_v1(NULL, NULL, v_new_hash);
    END IF;
    v_claimed_rev := NULLIF(v_up->>'metadata_revision', '')::integer;
    IF v_kind IN ('report_metadata', 'daily_metadata')
       AND v_claimed_rev IS DISTINCT FROM v_expected THEN
      UPDATE public.tally_sync_delivery_batches
      SET status = 'manual_review',
          last_error_safe = left(format('Metadata revision mismatch; expected %s', v_expected), 500),
          tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
          ack_summary = COALESCE(p_ack_summary, '{}'::jsonb), updated_at = now()
      WHERE id = p_batch_id;
      UPDATE public.tally_sync_jobs
      SET status = 'waiting_for_connector', error_code = 'tally_metadata_revision_mismatch',
          error_message_safe = 'A delivery needs metadata reconciliation before processing can continue'
      WHERE id = v_batch.job_id AND status <> 'completed';
      RETURN jsonb_build_object('ok', false, 'error', 'metadata_revision_mismatch', 'batch_status', 'manual_review');
    END IF;
  END LOOP;

  -- Locks held from validation guarantee the revisions cannot change between validation and write.
  FOR v_up IN SELECT value FROM jsonb_array_elements(v_updates)
  LOOP
    v_key := v_up->>'delivery_key';
    v_new_hash := NULLIF(v_up->>'content_hash', '');
    v_kind := COALESCE(v_up->>'delivery_kind', 'report_metadata');
    SELECT * INTO v_state FROM public.tally_delivery_state
    WHERE organization_id = v_org AND delivery_key = v_key;
    v_expected := public.tally_expected_metadata_revision_v1(
      v_state.last_content_hash, v_state.last_metadata_revision, v_new_hash
    );
    v_claimed_rev := NULLIF(v_up->>'metadata_revision', '')::integer;
    INSERT INTO public.tally_delivery_state (
      organization_id, delivery_key, delivery_kind, last_content_hash,
      last_metadata_revision, tally_remote_id, last_action, last_job_id, updated_at
    ) VALUES (
      v_org, v_key, v_kind, v_new_hash,
      CASE WHEN v_kind IN ('report_metadata', 'daily_metadata') THEN v_claimed_rev ELSE NULL END,
      NULLIF(v_up->>'tally_remote_id', ''), COALESCE(v_up->>'last_action', 'create'), v_batch.job_id, now()
    )
    ON CONFLICT (organization_id, delivery_key) DO UPDATE
    SET delivery_kind = EXCLUDED.delivery_kind,
        last_content_hash = EXCLUDED.last_content_hash,
        last_metadata_revision = CASE
          WHEN EXCLUDED.delivery_kind IN ('report_metadata', 'daily_metadata')
            THEN GREATEST(COALESCE(tally_delivery_state.last_metadata_revision, 0), EXCLUDED.last_metadata_revision)
          ELSE tally_delivery_state.last_metadata_revision END,
        tally_remote_id = COALESCE(EXCLUDED.tally_remote_id, tally_delivery_state.tally_remote_id),
        last_action = EXCLUDED.last_action, last_job_id = EXCLUDED.last_job_id, updated_at = now();
  END LOOP;

  UPDATE public.tally_sync_delivery_batches
  SET status = 'delivered', ack_summary = COALESCE(p_ack_summary, '{}'::jsonb),
      tally_response_safe = left(COALESCE(p_tally_response_safe, ''), 4000),
      completed_at = now(), updated_at = now()
  WHERE id = p_batch_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.tally_sync_delivery_batches
    WHERE job_id = v_batch.job_id AND status NOT IN ('delivered', 'skipped')
  ) THEN
    UPDATE public.tally_sync_jobs SET status = 'completed', completed_at = now(),
      error_code = NULL, error_message_safe = NULL
    WHERE id = v_batch.job_id;
  ELSE
    UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector'
    WHERE id = v_batch.job_id AND status <> 'completed';
  END IF;

  RETURN jsonb_build_object('ok', true, 'job_id', v_batch.job_id, 'batch_status', 'delivered');
END;
$$;

REVOKE ALL ON FUNCTION public.connector_ack_delivery_batch_v1(uuid, uuid, boolean, jsonb, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_ack_delivery_batch_v1(uuid, uuid, boolean, jsonb, text, text, jsonb) TO service_role;

-- Auditable reconciliation gate. A retry is possible only by an organization admin supplying evidence.
CREATE TABLE IF NOT EXISTS public.tally_delivery_reconciliation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.tally_sync_jobs(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES public.tally_sync_delivery_batches(id) ON DELETE CASCADE,
  decided_by uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('confirm_delivered', 'authorize_retry')),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 20 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tally_delivery_reconciliation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tally_delivery_reconciliation_admin_select_v1
  ON public.tally_delivery_reconciliation_events FOR SELECT TO authenticated
  USING (public.tally_sync_admin_can_view_v1(organization_id));
REVOKE ALL ON public.tally_delivery_reconciliation_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tally_delivery_reconciliation_events TO authenticated;
GRANT ALL ON public.tally_delivery_reconciliation_events TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_tally_delivery_batch_v1(
  p_batch_id uuid, p_decision text, p_evidence text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch public.tally_sync_delivery_batches%ROWTYPE;
  v_user uuid := auth.uid();
  v_state public.tally_delivery_state%ROWTYPE;
  v_expected integer;
  v_revision integer;
  v_update jsonb;
BEGIN
  IF v_user IS NULL OR p_decision IS NULL OR p_decision NOT IN ('confirm_delivered', 'authorize_retry')
     OR length(btrim(COALESCE(p_evidence, ''))) NOT BETWEEN 20 AND 2000 THEN
    RAISE EXCEPTION 'valid admin decision and reconciliation evidence are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_batch FROM public.tally_sync_delivery_batches
  WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch not found' USING ERRCODE = '22023'; END IF;
  IF NOT public.tally_sync_admin_can_view_v1(v_batch.organization_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF v_batch.status <> 'manual_review' THEN
    RAISE EXCEPTION 'only manual-review batches can be reconciled' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tally_delivery_reconciliation_events
    (organization_id, job_id, batch_id, decided_by, decision, evidence)
  VALUES (v_batch.organization_id, v_batch.job_id, v_batch.id, v_user, p_decision, btrim(p_evidence));

  IF p_decision = 'authorize_retry' THEN
    UPDATE public.tally_sync_delivery_batches
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL,
        last_error_safe = 'Retry explicitly authorized after reconciliation; see audit event', updated_at = now()
    WHERE id = v_batch.id;
    UPDATE public.tally_sync_jobs SET status = 'waiting_for_connector', error_code = NULL,
      error_message_safe = NULL, completed_at = NULL
    WHERE id = v_batch.job_id AND status <> 'completed';
  ELSE
    -- Treat confirmed delivery as a durable metadata acknowledgment too. Apply the frozen,
    -- organization-scoped updates only if their revision still matches current state.
    FOR v_update IN SELECT value FROM jsonb_array_elements(COALESCE(v_batch.delivery_updates, '[]'::jsonb))
      ORDER BY value->>'delivery_key'
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(
        v_batch.organization_id::text || ':' || (v_update->>'delivery_key'), 0
      ));
    END LOOP;
    FOR v_update IN SELECT value FROM jsonb_array_elements(COALESCE(v_batch.delivery_updates, '[]'::jsonb))
    LOOP
      SELECT * INTO v_state FROM public.tally_delivery_state
      WHERE organization_id = v_batch.organization_id AND delivery_key = v_update->>'delivery_key'
      FOR UPDATE;
      v_expected := public.tally_expected_metadata_revision_v1(
        v_state.last_content_hash, v_state.last_metadata_revision, NULLIF(v_update->>'content_hash', '')
      );
      v_revision := NULLIF(v_update->>'metadata_revision', '')::integer;
      IF COALESCE(v_update->>'delivery_kind', 'report_metadata') IN ('report_metadata', 'daily_metadata')
         AND v_revision IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'metadata revision changed; cannot confirm batch delivery' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    FOR v_update IN SELECT value FROM jsonb_array_elements(COALESCE(v_batch.delivery_updates, '[]'::jsonb))
    LOOP
      SELECT * INTO v_state FROM public.tally_delivery_state
      WHERE organization_id = v_batch.organization_id AND delivery_key = v_update->>'delivery_key';
      v_expected := public.tally_expected_metadata_revision_v1(
        v_state.last_content_hash, v_state.last_metadata_revision, NULLIF(v_update->>'content_hash', '')
      );
      v_revision := NULLIF(v_update->>'metadata_revision', '')::integer;
      INSERT INTO public.tally_delivery_state (
        organization_id, delivery_key, delivery_kind, last_content_hash, last_metadata_revision,
        tally_remote_id, last_action, last_job_id, updated_at
      ) VALUES (
        v_batch.organization_id, v_update->>'delivery_key',
        COALESCE(v_update->>'delivery_kind', 'report_metadata'), NULLIF(v_update->>'content_hash', ''),
        CASE WHEN COALESCE(v_update->>'delivery_kind', 'report_metadata') IN ('report_metadata', 'daily_metadata')
          THEN v_revision ELSE NULL END,
        NULLIF(v_update->>'tally_remote_id', ''), COALESCE(v_update->>'last_action', 'create'), v_batch.job_id, now()
      )
      ON CONFLICT (organization_id, delivery_key) DO UPDATE
      SET delivery_kind = EXCLUDED.delivery_kind, last_content_hash = EXCLUDED.last_content_hash,
          last_metadata_revision = CASE
            WHEN EXCLUDED.delivery_kind IN ('report_metadata', 'daily_metadata')
              THEN GREATEST(COALESCE(tally_delivery_state.last_metadata_revision, 0), EXCLUDED.last_metadata_revision)
            ELSE tally_delivery_state.last_metadata_revision END,
          tally_remote_id = COALESCE(EXCLUDED.tally_remote_id, tally_delivery_state.tally_remote_id),
          last_action = EXCLUDED.last_action, last_job_id = EXCLUDED.last_job_id, updated_at = now();
    END LOOP;
    UPDATE public.tally_sync_delivery_batches
    SET status = 'delivered', completed_at = now(),
        ack_summary = COALESCE(ack_summary, '{}'::jsonb) || jsonb_build_object('reconciled', true), updated_at = now()
    WHERE id = v_batch.id;
    IF NOT EXISTS (SELECT 1 FROM public.tally_sync_delivery_batches
      WHERE job_id = v_batch.job_id AND status NOT IN ('delivered', 'skipped')) THEN
      UPDATE public.tally_sync_jobs SET status = 'completed', completed_at = now(),
        error_code = NULL, error_message_safe = NULL WHERE id = v_batch.job_id;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch.id, 'decision', p_decision);
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_tally_delivery_batch_v1(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_tally_delivery_batch_v1(uuid, text, text) TO authenticated;
