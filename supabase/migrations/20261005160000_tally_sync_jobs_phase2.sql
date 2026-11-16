-- Phase 2: Tally sync job queue (admin-only enqueue). No Tally transport.

CREATE TABLE IF NOT EXISTS public.tally_sync_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_by        uuid NOT NULL,
  report_type         text NOT NULL,
  parameters          jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key          text NOT NULL,

  status              text NOT NULL DEFAULT 'queued',
  error_code          text,
  error_message_safe  text,

  source_row_count    bigint,
  processed_row_count bigint,
  created_count       bigint,
  updated_count       bigint,
  skipped_count       bigint,
  failed_count        bigint,
  connector_device_id text,

  attempt_count       integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,

  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,

  CONSTRAINT tally_sync_jobs_status_check
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  CONSTRAINT tally_sync_jobs_report_type_check
    CHECK (report_type IN (
      'claim_verification', 'claim_approval', 'detailed_expense', 'daily_project_report'
    )),
  CONSTRAINT tally_sync_jobs_attempts_check
    CHECK (attempt_count >= 0 AND max_attempts >= 1)
);

COMMENT ON TABLE public.tally_sync_jobs IS
  'Admin-initiated Tally sync jobs. Phase 2: enqueue only; worker/Tally transport in later phases.';

CREATE INDEX IF NOT EXISTS tally_sync_jobs_queue_idx
  ON public.tally_sync_jobs (created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS tally_sync_jobs_org_created_idx
  ON public.tally_sync_jobs (organization_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS tally_sync_jobs_active_dedupe_idx
  ON public.tally_sync_jobs (dedupe_key)
  WHERE status IN ('queued', 'processing');

-- Admin helper must exist before RLS policies reference it.
CREATE OR REPLACE FUNCTION public.tally_sync_admin_can_view_v1(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT m.role::text = 'admin'
      FROM public.organization_memberships m
      WHERE m.user_id = auth.uid()
        AND m.organization_id = p_organization_id
        AND m.is_active = true
      LIMIT 1
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.tally_sync_admin_can_view_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tally_sync_admin_can_view_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.tally_sync_admin_can_view_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.tally_sync_admin_can_view_v1(uuid) IS
  'Stricter than daily_report_caller_can_view_v1: organization admin role only (no accountant cashier).';

ALTER TABLE public.tally_sync_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org admins can read tally sync jobs" ON public.tally_sync_jobs;
CREATE POLICY "Org admins can read tally sync jobs"
  ON public.tally_sync_jobs FOR SELECT
  USING (public.tally_sync_admin_can_view_v1(organization_id));

-- Writes via create_tally_sync_job_v1 only (SECURITY DEFINER).

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

  v_dedupe := md5(
    p_organization_id::text || '|' || p_report_type || '|' || v_params::text
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
    organization_id, requested_by, report_type, parameters, dedupe_key, status
  ) VALUES (
    p_organization_id, v_uid, p_report_type, v_params, v_dedupe, 'queued'
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

COMMENT ON FUNCTION public.create_tally_sync_job_v1(uuid, text, jsonb) IS
  'Admin-only: enqueue a Tally sync job with frozen report parameters. No Tally I/O in Phase 2.';

DO $$
BEGIN
  IF to_regclass('public.tally_sync_jobs') IS NULL THEN
    RAISE EXCEPTION 'tally_sync_jobs missing';
  END IF;
  IF to_regprocedure('public.create_tally_sync_job_v1(uuid, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'create_tally_sync_job_v1 missing';
  END IF;
  IF has_function_privilege('anon', 'public.create_tally_sync_job_v1(uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute create_tally_sync_job_v1';
  END IF;
END;
$$;
