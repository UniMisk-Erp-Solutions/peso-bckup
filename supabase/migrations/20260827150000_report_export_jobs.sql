-- Server-side report generation, part 1 of 4 — durable job queue.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- Additive only: one new table, its indexes/RLS, eight new functions, one new
-- private storage bucket and its policies. Nothing existing is modified.
-- ============================================================================
--
-- INTEGRATION PROVENANCE — read before touching this file.
--
-- This table and its lifecycle functions originate from
-- `origin/feature/daily-project-report-export-jobs` (migration
-- `20260820170000_report_export_jobs.sql`, authored for the Daily Project
-- Report only, never merged, never applied to any database per its own
-- header). `origin/feature/preet-patel-changes` built a worker and a unified
-- four-report-type UI on top of this exact schema without ever including its
-- own copy of the table — its migrations only ALTER it. Porting Preet's work
-- alone onto a fresh `main` would fail immediately with
-- "relation report_export_jobs does not exist", so this file ports the
-- ORIGINAL table/queue design, with one adaptation: the `report_type` check
-- constraint below already allows all four report types from the start
-- (`daily_project_report`, `claim_verification`, `claim_approval`,
-- `detailed_expense`) instead of being created narrow and widened by a later
-- ALTER — there is no reason to replay that churn in a migration nobody has
-- ever run. Everything else in this file is functionally unchanged from the
-- source branch; it was already a clean, generic, report-type-agnostic design
-- (the RLS policies and storage policy never hardcode a report type).
--
-- WHY
--
-- The Daily Project Report's own server-side pagination (already on `main`,
-- `20260820160000_daily_project_report_server_pagination.sql`) still requires
-- the BROWSER to stay open for the whole export: React Query drives every
-- page, and closing the tab loses the work. Claim Verification, Claim
-- Approval and Detailed Expense have no server-side pagination at all today —
-- they are plain, unbounded PostgREST queries subject to this deployment's
-- row cap, silently truncating large exports with no error shown.
--
-- This migration makes report generation a durable, server-owned JOB for all
-- four report types. The browser enqueues it and may leave; a worker
-- generates the file, uploads it to a PRIVATE bucket and flips the job to
-- completed. The user finds it under each tab's own "Report history"
-- whenever they come back.
--
-- SECURITY POSTURE
--   * enqueue: authenticated only; organization, requester and report
--     permission are all derived from auth.uid() server-side, never trusted
--     from the client.
--   * worker functions: granted to service_role ONLY. An ordinary
--     authenticated user cannot claim, complete or fail a job.
--   * storage: private bucket, path-scoped by organization, readable only by
--     a caller who passes the same report-permission check as the enqueue
--     path.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The job table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.report_export_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_by        uuid NOT NULL,
  report_type         text NOT NULL,
  format              text NOT NULL DEFAULT 'csv',
  parameters          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The exact mapping configuration this job must use, frozen at enqueue time
  -- (Daily Project Report's project/category field mappings). NULL for the
  -- three expense-list report types, which have no equivalent configuration.
  config_snapshot     jsonb,
  -- Stable fingerprint used to collapse double-clicks onto one active job.
  -- See the partial unique index below.
  dedupe_key          text NOT NULL,

  status              text NOT NULL DEFAULT 'queued',
  progress_current    integer NOT NULL DEFAULT 0,
  progress_total      integer,
  snapshot_at         timestamptz,

  storage_path        text,
  filename            text,
  mime_type           text,
  file_size_bytes     bigint,

  error_code          text,
  error_message_safe  text,

  attempt_count       integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,
  worker_id           text,
  worker_heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  -- Set when a failed job is manually retried, so the audit trail survives.
  superseded_by       uuid REFERENCES public.report_export_jobs(id) ON DELETE SET NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '7 days'),

  CONSTRAINT report_export_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT report_export_jobs_format_check
    CHECK (format IN ('xlsx', 'csv')),
  CONSTRAINT report_export_jobs_report_type_check
    CHECK (report_type IN (
      'daily_project_report', 'claim_verification', 'claim_approval', 'detailed_expense'
    )),
  CONSTRAINT report_export_jobs_progress_check
    CHECK (progress_current >= 0 AND (progress_total IS NULL OR progress_total >= 0)),
  CONSTRAINT report_export_jobs_attempts_check
    CHECK (attempt_count >= 0 AND max_attempts >= 1),
  -- A completed job must name its file. `storage_path` is deliberately NOT
  -- part of this constraint: the retention sweep nulls it when the object is
  -- deleted after 7 days, while keeping the row so the audit trail of who
  -- exported what survives the file. Completion itself is the strict gate --
  -- complete_report_export_job_v1 refuses (22023) without a real
  -- storage_path, so "an incomplete export never publishes a file" is
  -- enforced there.
  CONSTRAINT report_export_jobs_completed_needs_file
    CHECK (status <> 'completed' OR filename IS NOT NULL)
);

COMMENT ON TABLE public.report_export_jobs IS
  'Durable queue for background report generation across all four Reports '
  'tabs. Survives browser close; a worker claims, generates, uploads and '
  'completes each job.';

-- Queue scan: the worker asks only for the oldest queued job.
CREATE INDEX IF NOT EXISTS report_export_jobs_queue_idx
  ON public.report_export_jobs (created_at)
  WHERE status = 'queued';

-- Stale-heartbeat recovery sweep.
CREATE INDEX IF NOT EXISTS report_export_jobs_running_heartbeat_idx
  ON public.report_export_jobs (worker_heartbeat_at)
  WHERE status = 'running';

-- Report history list: newest first, per organization + report type.
CREATE INDEX IF NOT EXISTS report_export_jobs_org_type_created_idx
  ON public.report_export_jobs (organization_id, report_type, created_at DESC);

-- Retention sweep.
CREATE INDEX IF NOT EXISTS report_export_jobs_expires_idx
  ON public.report_export_jobs (expires_at)
  WHERE status = 'completed';

-- Double-click protection: at most ONE active job per identical request.
CREATE UNIQUE INDEX IF NOT EXISTS report_export_jobs_active_dedupe_idx
  ON public.report_export_jobs (dedupe_key)
  WHERE status IN ('queued', 'running');


-- ── 2. RLS ───────────────────────────────────────────────────────────────────
-- Read-only for users; every state transition goes through a function so no
-- client can move a job to 'completed' or point it at another org's file.
ALTER TABLE public.report_export_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Report viewers can see their organization's export jobs"
  ON public.report_export_jobs;
CREATE POLICY "Report viewers can see their organization's export jobs"
  ON public.report_export_jobs FOR SELECT
  USING (
    public.daily_report_caller_can_view_v1(organization_id, false)
    OR (
      requested_by = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.organization_memberships m
        WHERE m.user_id = auth.uid()
          AND m.organization_id = report_export_jobs.organization_id
          AND m.is_active = true
      )
    )
  );

-- No INSERT/UPDATE/DELETE policy exists on purpose: writes are function-only.


-- ── 3. Worker: claim ─────────────────────────────────────────────────────────
-- FOR UPDATE SKIP LOCKED is what makes two workers never take the same job.
CREATE OR REPLACE FUNCTION public.claim_report_export_job_v1(
  p_worker_id       text,
  p_max_per_org     integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.report_export_jobs%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;

  SELECT j.* INTO v_job
  FROM public.report_export_jobs j
  WHERE j.status = 'queued'
    AND j.cancel_requested_at IS NULL
    -- Per-organization concurrency cap: never let one tenant monopolise the DB.
    AND (
      SELECT count(*) FROM public.report_export_jobs r
      WHERE r.organization_id = j.organization_id AND r.status = 'running'
    ) < GREATEST(COALESCE(p_max_per_org, 1), 1)
  ORDER BY j.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  UPDATE public.report_export_jobs
  SET status = 'running',
      worker_id = p_worker_id,
      started_at = COALESCE(started_at, now()),
      worker_heartbeat_at = now(),
      attempt_count = attempt_count + 1,
      error_code = NULL,
      error_message_safe = NULL
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object('claimed', true, 'job', to_jsonb(v_job));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_report_export_job_v1(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_report_export_job_v1(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_report_export_job_v1(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_report_export_job_v1(text, integer) TO service_role;


-- ── 4. User-facing: cancel ───────────────────────────────────────────────────
-- Queued cancels immediately. Running only REQUESTS cancellation; the worker
-- observes it between chunks and stops without publishing a file.
CREATE OR REPLACE FUNCTION public.cancel_report_export_job_v1(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.report_export_jobs%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_job FROM public.report_export_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    v_job.requested_by = auth.uid()
    OR public.daily_report_caller_can_view_v1(v_job.organization_id, false)
  ) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;

  IF v_job.status = 'queued' THEN
    UPDATE public.report_export_jobs
    SET status = 'cancelled', cancel_requested_at = now(), completed_at = now()
    WHERE id = p_job_id;
    RETURN jsonb_build_object('job_id', p_job_id, 'status', 'cancelled');
  ELSIF v_job.status = 'running' THEN
    UPDATE public.report_export_jobs
    SET cancel_requested_at = COALESCE(cancel_requested_at, now())
    WHERE id = p_job_id;
    RETURN jsonb_build_object('job_id', p_job_id, 'status', 'running', 'cancel_requested', true);
  END IF;

  RETURN jsonb_build_object('job_id', p_job_id, 'status', v_job.status, 'no_op', true);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_report_export_job_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_report_export_job_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_report_export_job_v1(uuid) TO authenticated;


-- ── 5. Worker: heartbeat + progress ──────────────────────────────────────────
-- Returns whether cancellation was requested so the worker can stop between
-- chunks. One call per page — never per row.
CREATE OR REPLACE FUNCTION public.report_export_job_heartbeat_v1(
  p_job_id           uuid,
  p_worker_id        text,
  p_progress_current integer DEFAULT NULL,
  p_progress_total   integer DEFAULT NULL,
  p_snapshot_at      timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.report_export_jobs%ROWTYPE;
BEGIN
  UPDATE public.report_export_jobs
  SET worker_heartbeat_at = now(),
      progress_current = COALESCE(p_progress_current, progress_current),
      progress_total   = COALESCE(p_progress_total, progress_total),
      snapshot_at      = COALESCE(snapshot_at, p_snapshot_at)
  WHERE id = p_job_id AND worker_id = p_worker_id AND status = 'running'
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    -- Someone else owns this job now (recovered after a stale heartbeat), or
    -- it is no longer running. Tell the worker to abandon it.
    RETURN jsonb_build_object('ok', false, 'lost', true);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'cancel_requested', v_job.cancel_requested_at IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_export_job_heartbeat_v1(uuid, text, integer, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_export_job_heartbeat_v1(uuid, text, integer, integer, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.report_export_job_heartbeat_v1(uuid, text, integer, integer, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.report_export_job_heartbeat_v1(uuid, text, integer, integer, timestamptz) TO service_role;


-- ── 6. Worker: finish ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_report_export_job_v1(
  p_job_id          uuid,
  p_worker_id       text,
  p_storage_path    text,
  p_filename        text,
  p_mime_type       text,
  p_file_size_bytes bigint,
  p_row_count       integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.report_export_jobs%ROWTYPE;
BEGIN
  IF p_storage_path IS NULL OR btrim(p_storage_path) = ''
     OR p_filename IS NULL OR btrim(p_filename) = '' THEN
    RAISE EXCEPTION 'a completed job requires a stored file' USING ERRCODE = '22023';
  END IF;

  UPDATE public.report_export_jobs
  SET status = 'completed',
      storage_path = p_storage_path,
      filename = p_filename,
      mime_type = p_mime_type,
      file_size_bytes = p_file_size_bytes,
      progress_current = COALESCE(p_row_count, progress_current),
      progress_total = COALESCE(p_row_count, progress_total),
      completed_at = now(),
      worker_heartbeat_at = now(),
      error_code = NULL,
      error_message_safe = NULL
  WHERE id = p_job_id AND worker_id = p_worker_id AND status = 'running'
    -- A cancellation that landed mid-run wins: no file is ever published.
    AND cancel_requested_at IS NULL
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'lost', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'job_id', v_job.id);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_report_export_job_v1(uuid, text, text, text, text, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_report_export_job_v1(uuid, text, text, text, text, bigint, integer) FROM anon;
REVOKE ALL ON FUNCTION public.complete_report_export_job_v1(uuid, text, text, text, text, bigint, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_report_export_job_v1(uuid, text, text, text, text, bigint, integer) TO service_role;


CREATE OR REPLACE FUNCTION public.fail_report_export_job_v1(
  p_job_id             uuid,
  p_worker_id          text,
  p_error_code         text,
  p_error_message_safe text,
  p_retryable          boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job    public.report_export_jobs%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO v_job FROM public.report_export_jobs
  WHERE id = p_job_id AND worker_id = p_worker_id AND status = 'running'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'lost', true);
  END IF;

  IF v_job.cancel_requested_at IS NOT NULL THEN
    v_status := 'cancelled';
  ELSIF COALESCE(p_retryable, true) AND v_job.attempt_count < v_job.max_attempts THEN
    v_status := 'queued';           -- back on the queue for another attempt
  ELSE
    v_status := 'failed';
  END IF;

  UPDATE public.report_export_jobs
  SET status = v_status,
      error_code = p_error_code,
      -- Only pre-sanitised text reaches this column; never raw SQL/PG errors.
      error_message_safe = left(COALESCE(p_error_message_safe, ''), 500),
      worker_id = CASE WHEN v_status = 'queued' THEN NULL ELSE worker_id END,
      completed_at = CASE WHEN v_status IN ('failed', 'cancelled') THEN now() ELSE NULL END
  WHERE id = p_job_id;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.fail_report_export_job_v1(uuid, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_report_export_job_v1(uuid, text, text, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.fail_report_export_job_v1(uuid, text, text, text, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fail_report_export_job_v1(uuid, text, text, text, boolean) TO service_role;


-- ── 7. Crash recovery ────────────────────────────────────────────────────────
-- A worker that dies mid-job leaves it 'running' forever. Anything whose
-- heartbeat has gone stale is requeued (or failed once attempts run out).
-- NOTE: nothing in this repository schedules this function's execution (no
-- pg_cron entry found on any branch touching this feature). It must be
-- invoked periodically by an external scheduler once this ships; documented
-- as a known operational gap in the integration report.
CREATE OR REPLACE FUNCTION public.recover_stale_report_export_jobs_v1(
  p_stale_after interval DEFAULT interval '5 minutes'
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
    FROM public.report_export_jobs
    WHERE status = 'running'
      AND COALESCE(worker_heartbeat_at, started_at, created_at) < now() - p_stale_after
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE public.report_export_jobs j
    SET status = CASE WHEN s.attempt_count < s.max_attempts THEN 'queued' ELSE 'failed' END,
        worker_id = NULL,
        error_code = CASE WHEN s.attempt_count < s.max_attempts THEN NULL ELSE 'worker_lost' END,
        error_message_safe = CASE WHEN s.attempt_count < s.max_attempts THEN NULL
                                  ELSE 'The report worker stopped responding.' END,
        completed_at = CASE WHEN s.attempt_count < s.max_attempts THEN NULL ELSE now() END
    FROM stale s
    WHERE j.id = s.id
    RETURNING j.status
  )
  SELECT count(*) FILTER (WHERE status = 'queued'),
         count(*) FILTER (WHERE status = 'failed')
  INTO v_requeued, v_failed
  FROM updated;

  RETURN jsonb_build_object('requeued', COALESCE(v_requeued, 0), 'failed', COALESCE(v_failed, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_report_export_jobs_v1(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recover_stale_report_export_jobs_v1(interval) FROM anon;
REVOKE ALL ON FUNCTION public.recover_stale_report_export_jobs_v1(interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_report_export_jobs_v1(interval) TO service_role;


-- ── 8. Retention ─────────────────────────────────────────────────────────────
-- Returns the storage paths the worker should delete, then marks the rows so
-- a second sweep cannot double-report them. Job metadata is retained (file
-- fields cleared) rather than deleted, so the audit trail of who exported
-- what survives the file itself.
-- NOTE: same operational gap as above — nothing schedules this function's
-- execution anywhere in this repository today.
CREATE OR REPLACE FUNCTION public.expire_report_export_files_v1(
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paths jsonb;
BEGIN
  WITH due AS (
    SELECT id, storage_path
    FROM public.report_export_jobs
    WHERE status = 'completed'
      AND storage_path IS NOT NULL
      AND expires_at < now()
    ORDER BY expires_at
    LIMIT GREATEST(COALESCE(p_limit, 100), 1)
    FOR UPDATE SKIP LOCKED
  ),
  cleared AS (
    UPDATE public.report_export_jobs j
    SET storage_path = NULL,
        error_code = 'expired',
        error_message_safe = 'This report has expired and its file was removed.'
    FROM due
    WHERE j.id = due.id
    RETURNING due.storage_path
  )
  SELECT COALESCE(jsonb_agg(storage_path), '[]'::jsonb) INTO v_paths FROM cleared;

  RETURN jsonb_build_object('paths', v_paths);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_report_export_files_v1(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_report_export_files_v1(integer) FROM anon;
REVOKE ALL ON FUNCTION public.expire_report_export_files_v1(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_report_export_files_v1(integer) TO service_role;


-- ── 9. Private storage bucket ───────────────────────────────────────────────
-- Path convention actually used by the worker: {organization_id}/{job_id}/{filename}.
-- (A report-type segment was considered but dropped since job_id is already
-- unique and every job already carries its own report_type column.)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'generated-reports',
  'generated-reports',
  false,                       -- PRIVATE. Never flip this to true.
  524288000,                   -- 500 MB ceiling for very large exports
  ARRAY[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Read is granted only to a caller who would be allowed to generate the
-- report for that organization, and only for their own organization's
-- folder. This is what makes `createSignedUrl` safe to call straight from
-- the browser: the user's own JWT must satisfy the policy, and no
-- service-role key is exposed.
DROP POLICY IF EXISTS "Report viewers can read their organization's generated reports"
  ON storage.objects;
CREATE POLICY "Report viewers can read their organization's generated reports"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'generated-reports'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND public.daily_report_caller_can_view_v1(
          ((storage.foldername(name))[1])::uuid, false)
  );

-- No INSERT/UPDATE/DELETE policy: only the worker's service-role key writes
-- here, and service_role bypasses RLS.


-- ── 10. Realtime ─────────────────────────────────────────────────────────────
-- Lets each tab's Report history refresh itself as the worker progresses.
-- RLS still applies to realtime, so a user only receives their own org's rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'report_export_jobs'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.report_export_jobs;
    END IF;
  END IF;
END
$$;
