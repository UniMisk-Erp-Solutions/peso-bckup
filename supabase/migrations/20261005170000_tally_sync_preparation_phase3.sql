-- Phase 3: Tally sync dataset preparation (prepared state, job items, worker RPCs).

ALTER TABLE public.tally_sync_jobs
  DROP CONSTRAINT IF EXISTS tally_sync_jobs_status_check;

ALTER TABLE public.tally_sync_jobs
  ADD CONSTRAINT tally_sync_jobs_status_check
    CHECK (status IN ('queued', 'processing', 'prepared', 'completed', 'failed'));

ALTER TABLE public.tally_sync_jobs
  ADD COLUMN IF NOT EXISTS prepared_at timestamptz,
  ADD COLUMN IF NOT EXISTS prepared_item_count bigint,
  ADD COLUMN IF NOT EXISTS report_row_count bigint,
  ADD COLUMN IF NOT EXISTS preparation_checkpoint jsonb,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS config_snapshot jsonb;

COMMENT ON COLUMN public.tally_sync_jobs.config_snapshot IS
  'Frozen daily_expense_report_config for daily_project_report jobs (same as report_export_jobs).';

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

  IF p_report_type = 'daily_project_report' THEN
    SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) INTO v_config
    FROM public.organization_settings s
    WHERE s.organization_id = p_organization_id;
    v_config := COALESCE(v_config, '{}'::jsonb);
  END IF;

  v_dedupe := md5(
    p_organization_id::text || '|' || p_report_type || '|' || v_params::text ||
    COALESCE('|' || v_config::text, '')
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
    organization_id, requested_by, report_type, parameters, config_snapshot, dedupe_key, status
  ) VALUES (
    p_organization_id, v_uid, p_report_type, v_params, v_config, v_dedupe, 'queued'
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

COMMENT ON COLUMN public.tally_sync_jobs.prepared_at IS
  'When dataset preparation finished (Phase 3). Distinct from completed_at (future Tally delivery).';

DROP INDEX IF EXISTS tally_sync_jobs_active_dedupe_idx;
CREATE UNIQUE INDEX tally_sync_jobs_active_dedupe_idx
  ON public.tally_sync_jobs (dedupe_key)
  WHERE status IN ('queued', 'processing');

CREATE TABLE IF NOT EXISTS public.tally_sync_job_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES public.tally_sync_jobs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  source_type     text NOT NULL,
  source_key      text NOT NULL,
  content_hash    text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tally_sync_job_items_source_key_unique UNIQUE (job_id, source_key)
);

CREATE INDEX IF NOT EXISTS tally_sync_job_items_job_seq_idx
  ON public.tally_sync_job_items (job_id, seq);

ALTER TABLE public.tally_sync_job_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org admins can read tally sync job items" ON public.tally_sync_job_items;
CREATE POLICY "Org admins can read tally sync job items"
  ON public.tally_sync_job_items FOR SELECT
  USING (public.tally_sync_admin_can_view_v1(organization_id));

CREATE OR REPLACE FUNCTION public.claim_tally_sync_job_v1(
  p_worker_id text,
  p_job_id    uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.tally_sync_jobs%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;

  IF p_job_id IS NOT NULL THEN
    SELECT * INTO v_job
    FROM public.tally_sync_jobs j
    WHERE j.id = p_job_id AND j.status = 'queued'
    FOR UPDATE SKIP LOCKED;
  ELSE
    SELECT * INTO v_job
    FROM public.tally_sync_jobs j
    WHERE j.status = 'queued'
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  UPDATE public.tally_sync_jobs
  SET status = 'processing',
      worker_id = p_worker_id,
      started_at = COALESCE(started_at, now()),
      worker_heartbeat_at = now(),
      attempt_count = attempt_count + 1,
      error_code = NULL,
      error_message_safe = NULL,
      preparation_checkpoint = NULL
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  DELETE FROM public.tally_sync_job_items WHERE job_id = v_job.id;

  RETURN jsonb_build_object('claimed', true, 'job', to_jsonb(v_job));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_tally_sync_job_v1(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_tally_sync_job_v1(text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tally_sync_job_v1(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tally_sync_job_heartbeat_v1(
  p_job_id    uuid,
  p_worker_id text,
  p_progress_current bigint DEFAULT NULL,
  p_progress_total   bigint DEFAULT NULL,
  p_checkpoint       jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.tally_sync_jobs
  SET worker_heartbeat_at = now(),
      processed_row_count = COALESCE(p_progress_current, processed_row_count),
      source_row_count = COALESCE(p_progress_total, source_row_count),
      preparation_checkpoint = COALESCE(p_checkpoint, preparation_checkpoint)
  WHERE id = p_job_id
    AND worker_id = p_worker_id
    AND status = 'processing';
END;
$$;

REVOKE ALL ON FUNCTION public.tally_sync_job_heartbeat_v1(uuid, text, bigint, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tally_sync_job_heartbeat_v1(uuid, text, bigint, bigint, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tally_sync_job_heartbeat_v1(uuid, text, bigint, bigint, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.store_tally_sync_job_items_chunk_v1(
  p_job_id          uuid,
  p_worker_id       text,
  p_items           jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.tally_sync_jobs%ROWTYPE;
  v_n   integer := 0;
BEGIN
  SELECT * INTO v_job FROM public.tally_sync_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.worker_id IS DISTINCT FROM p_worker_id OR v_job.status <> 'processing' THEN
    RAISE EXCEPTION 'job not claimable by this worker' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'items must be a json array' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tally_sync_job_items (
    job_id, organization_id, seq, source_type, source_key, content_hash, payload
  )
  SELECT
    p_job_id,
    v_job.organization_id,
    (item ->> 'seq')::bigint,
    item ->> 'source_type',
    item ->> 'source_key',
    item ->> 'content_hash',
    item -> 'payload'
  FROM jsonb_array_elements(p_items) AS item
  ON CONFLICT (job_id, source_key) DO UPDATE SET
    seq = EXCLUDED.seq,
    content_hash = EXCLUDED.content_hash,
    payload = EXCLUDED.payload;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.store_tally_sync_job_items_chunk_v1(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_tally_sync_job_items_chunk_v1(uuid, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_tally_sync_job_items_chunk_v1(uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_tally_sync_preparation_v1(
  p_job_id              uuid,
  p_worker_id           text,
  p_prepared_item_count bigint,
  p_report_row_count    bigint DEFAULT NULL,
  p_source_record_count bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.tally_sync_jobs%ROWTYPE;
  v_items bigint;
BEGIN
  SELECT * INTO v_job FROM public.tally_sync_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.worker_id IS DISTINCT FROM p_worker_id OR v_job.status <> 'processing' THEN
    RAISE EXCEPTION 'job not in processing state for this worker' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_items FROM public.tally_sync_job_items WHERE job_id = p_job_id;
  IF v_items <> p_prepared_item_count THEN
    RAISE EXCEPTION 'prepared item count mismatch: expected %, table has %', p_prepared_item_count, v_items
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.tally_sync_jobs
  SET status = 'prepared',
      prepared_at = now(),
      prepared_item_count = p_prepared_item_count,
      report_row_count = p_report_row_count,
      source_row_count = COALESCE(p_source_record_count, source_row_count),
      processed_row_count = p_prepared_item_count,
      preparation_checkpoint = NULL,
      worker_heartbeat_at = now(),
      error_code = NULL,
      error_message_safe = NULL
  WHERE id = p_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_tally_sync_preparation_v1(uuid, text, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_tally_sync_preparation_v1(uuid, text, bigint, bigint, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_tally_sync_preparation_v1(uuid, text, bigint, bigint, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.fail_tally_sync_job_v1(
  p_job_id             uuid,
  p_worker_id          text,
  p_error_code         text,
  p_error_message_safe text,
  p_retryable          boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.tally_sync_jobs
  SET status = CASE
        WHEN p_retryable AND attempt_count < max_attempts THEN 'queued'
        ELSE 'failed'
      END,
      worker_id = CASE WHEN p_retryable AND attempt_count < max_attempts THEN NULL ELSE worker_id END,
      error_code = p_error_code,
      error_message_safe = left(p_error_message_safe, 300),
      preparation_checkpoint = NULL
  WHERE id = p_job_id
    AND worker_id = p_worker_id
    AND status = 'processing';

  IF p_retryable AND (SELECT attempt_count < max_attempts FROM public.tally_sync_jobs WHERE id = p_job_id) THEN
    DELETE FROM public.tally_sync_job_items WHERE job_id = p_job_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_tally_sync_job_v1(uuid, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_tally_sync_job_v1(uuid, text, text, text, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_tally_sync_job_v1(uuid, text, text, text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.tally_expense_meta_batch_v1(
  p_organization_id uuid,
  p_expense_ids       uuid[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(
    e.id::text,
    jsonb_build_object(
      'approval_tier', e.approval_tier,
      'deleted_at', e.deleted_at
    )
  ), '{}'::jsonb)
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.id = ANY (p_expense_ids);
$$;

REVOKE ALL ON FUNCTION public.tally_expense_meta_batch_v1(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tally_expense_meta_batch_v1(uuid, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tally_expense_meta_batch_v1(uuid, uuid[]) TO service_role;

DO $$
BEGIN
  IF to_regclass('public.tally_sync_job_items') IS NULL THEN
    RAISE EXCEPTION 'tally_sync_job_items missing';
  END IF;
END;
$$;
