-- Detailed Expense report: on-page paginated preview + report-history pagination.
--
-- WHY A STORED ROW SET, NOT A LIVE RE-QUERY:
-- report_balance_timeline_rows_v3 (the row source Detailed Expense already
-- uses) computes each employee's opening/closing balance BACKWARDS from
-- profiles.balance -- the LIVE wallet balance -- at query time. It has no
-- p_snapshot_at parameter and cannot be re-run later and still match a
-- previously-generated file: if the employee's live balance changes for any
-- reason after generation (a new expense approved, a transfer credited),
-- re-running the same query would silently produce different Opening/Closing
-- Balance values for the SAME historical rows. A live re-query preview would
-- therefore not reliably match the downloaded CSV -- exactly the drift this
-- feature must not have. So the worker stores the exact row objects it
-- already builds for the CSV (same in-memory array, not re-derived), and the
-- preview reads back that frozen set. Preview and export are provably the
-- same data by construction, not by coincidence.
--
-- Scope: Detailed Expense only. Claim Verification/Claim Approval/Daily
-- Project Report are untouched -- their own row-storage can be added later if
-- ever needed, following this same pattern.

-- ── 1. Storage for the frozen preview rows ──────────────────────────────────
ALTER TABLE public.report_export_jobs
  ADD COLUMN IF NOT EXISTS preview_columns text[];

COMMENT ON COLUMN public.report_export_jobs.preview_columns IS
  'Exact ordered column headers for this job''s stored preview rows -- the same array used to build the CSV header row. NULL for jobs with no stored preview (non-detailed_expense types, or jobs generated before this feature existed).';

CREATE TABLE IF NOT EXISTS public.report_export_job_rows (
  job_id     uuid NOT NULL REFERENCES public.report_export_jobs(id) ON DELETE CASCADE,
  row_index  integer NOT NULL,
  row_data   jsonb NOT NULL,
  PRIMARY KEY (job_id, row_index)
);

COMMENT ON TABLE public.report_export_job_rows IS
  'Frozen row set for a completed report job''s on-page preview, keyed by row_index for stable pagination. Written once by the worker at the same time it builds the CSV; never re-derived. Cascades away with its parent job.';

ALTER TABLE public.report_export_job_rows ENABLE ROW LEVEL SECURITY;
-- No policies: this table is never read/written directly by a client, only
-- through get_report_export_job_preview_v1 (SECURITY DEFINER, own auth
-- check) and the worker's own SECURITY DEFINER write RPCs below.
REVOKE ALL ON public.report_export_job_rows FROM PUBLIC;
REVOKE ALL ON public.report_export_job_rows FROM anon;
REVOKE ALL ON public.report_export_job_rows FROM authenticated;
GRANT ALL ON public.report_export_job_rows TO service_role;

-- ── 2. Worker-only writes ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.clear_report_export_job_preview_v1(
  p_job_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.report_export_job_rows WHERE job_id = p_job_id;
$$;

REVOKE ALL ON FUNCTION public.clear_report_export_job_preview_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_report_export_job_preview_v1(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.clear_report_export_job_preview_v1(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.clear_report_export_job_preview_v1(uuid) TO service_role;

-- One call per chunk (the worker calls this repeatedly for a large report --
-- never one call per row). p_rows is a jsonb ARRAY of row objects, in the
-- exact order they belong at p_start_index, p_start_index+1, ... . Re-running
-- the same chunk (a retried job) is safe: ON CONFLICT overwrites in place.
CREATE OR REPLACE FUNCTION public.store_report_export_job_preview_chunk_v1(
  p_job_id      uuid,
  p_start_index integer,
  p_columns     text[],
  p_rows        jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_start_index < 0 THEN
    RAISE EXCEPTION 'p_start_index must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a jsonb array' USING ERRCODE = '22023';
  END IF;

  UPDATE public.report_export_jobs
  SET preview_columns = p_columns
  WHERE id = p_job_id
    AND preview_columns IS DISTINCT FROM p_columns;

  WITH chunk AS (
    SELECT p_start_index + (ord - 1)::integer AS row_index, elem AS row_data
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(elem, ord)
  )
  INSERT INTO public.report_export_job_rows (job_id, row_index, row_data)
  SELECT p_job_id, row_index, row_data FROM chunk
  ON CONFLICT (job_id, row_index) DO UPDATE SET row_data = EXCLUDED.row_data;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.store_report_export_job_preview_chunk_v1(uuid, integer, text[], jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_report_export_job_preview_chunk_v1(uuid, integer, text[], jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.store_report_export_job_preview_chunk_v1(uuid, integer, text[], jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.store_report_export_job_preview_chunk_v1(uuid, integer, text[], jsonb) TO service_role;

-- ── 3. Authenticated, paginated preview read ────────────────────────────────
--
-- Same authorization rule as list_report_export_jobs_v1 (part 4 of the
-- original integration): daily_report_caller_can_view_v1(organization_id,
-- false). Matched deliberately for consistency with the existing history
-- RPC's own permission model, not re-derived.
CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v1(
  p_job_id    uuid,
  p_page      integer DEFAULT 1,
  p_page_size integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_job       public.report_export_jobs%ROWTYPE;
  v_page      integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 200);
  v_total     integer;
  v_rows      jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_job FROM public.report_export_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report not found' USING ERRCODE = '42704';
  END IF;

  IF NOT public.daily_report_caller_can_view_v1(v_job.organization_id, false) THEN
    RAISE EXCEPTION 'not permitted to view this report' USING ERRCODE = '42501';
  END IF;

  IF v_job.status <> 'completed' THEN
    RETURN jsonb_build_object(
      'schema_version', 1, 'ready', false, 'reason', 'not_completed',
      'columns', '[]'::jsonb, 'total_count', 0, 'page', v_page, 'page_size', v_page_size,
      'rows', '[]'::jsonb
    );
  END IF;

  IF v_job.preview_columns IS NULL THEN
    RETURN jsonb_build_object(
      'schema_version', 1, 'ready', false, 'reason', 'no_preview_available',
      'columns', '[]'::jsonb, 'total_count', 0, 'page', v_page, 'page_size', v_page_size,
      'rows', '[]'::jsonb
    );
  END IF;

  SELECT count(*) INTO v_total FROM public.report_export_job_rows WHERE job_id = p_job_id;

  SELECT COALESCE(jsonb_agg(r.row_data ORDER BY r.row_index), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT row_index, row_data
    FROM public.report_export_job_rows
    WHERE job_id = p_job_id
    ORDER BY row_index
    LIMIT v_page_size OFFSET (v_page - 1) * v_page_size
  ) r;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'ready', true,
    'reason', NULL,
    'columns', to_jsonb(v_job.preview_columns),
    'total_count', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_report_export_job_preview_v1(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_report_export_job_preview_v1(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_report_export_job_preview_v1(uuid, integer, integer) TO authenticated;

-- ── 4. Report History, properly paginated ───────────────────────────────────
--
-- v1 (list_report_export_jobs_v1) is left completely unchanged for any other
-- caller; this is a new, additive version with an offset + a real total
-- count, so the client can render "Page X of Y" instead of guessing from
-- rows.length. Same envelope shape as v1 plus `total_count` and `offset`.
CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v2(
  p_organization_id uuid,
  p_report_type     text,
  p_offset          integer DEFAULT 0,
  p_limit           integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_uid    uuid := auth.uid();
  v_out    jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_report_type NOT IN ('daily_project_report', 'claim_verification', 'claim_approval', 'detailed_expense') THEN
    RAISE EXCEPTION 'unsupported report type' USING ERRCODE = '22023';
  END IF;
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, false) THEN
    RAISE EXCEPTION 'not permitted to view this report' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'schema_version', 1,
    'offset', v_offset,
    'limit', v_limit,
    'total_count', (
      SELECT count(*)::integer FROM public.report_export_jobs
      WHERE organization_id = p_organization_id AND report_type = p_report_type AND status = 'completed'
    ),
    'jobs', COALESCE(jsonb_agg(jsonb_build_object(
      'id', j.id,
      'status', j.status,
      'filename', j.filename,
      'storage_path', j.storage_path,
      'file_size_bytes', j.file_size_bytes,
      'row_count', j.progress_current,
      'created_at', j.created_at,
      'completed_at', j.completed_at,
      'expires_at', j.expires_at,
      'requested_by_name', COALESCE(NULLIF(btrim(COALESCE(p.name, '')), ''), 'Unknown user'),
      'requested_by_me', (j.requested_by = v_uid),
      'downloadable', (
        j.status = 'completed'
        AND j.storage_path IS NOT NULL
        AND (j.expires_at IS NULL OR j.expires_at > now())
        AND EXISTS (
          SELECT 1 FROM storage.objects o
          WHERE o.bucket_id = 'generated-reports' AND o.name = j.storage_path
        )
      ),
      'has_preview', (j.preview_columns IS NOT NULL)
    ) ORDER BY j.created_at DESC), '[]'::jsonb)
  ) INTO v_out
  FROM (
    SELECT *
    FROM public.report_export_jobs
    WHERE organization_id = p_organization_id
      AND report_type = p_report_type
      AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) j
  LEFT JOIN public.profiles p ON p.user_id = j.requested_by AND p.organization_id = j.organization_id;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.list_report_export_jobs_v2(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_report_export_jobs_v2(uuid, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_report_export_jobs_v2(uuid, text, integer, integer) TO authenticated;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'report_export_jobs' AND column_name = 'preview_columns'
  ) THEN
    RAISE EXCEPTION 'report_export_jobs.preview_columns missing';
  END IF;
  IF to_regclass('public.report_export_job_rows') IS NULL THEN
    RAISE EXCEPTION 'report_export_job_rows table missing';
  END IF;
  IF to_regprocedure('public.clear_report_export_job_preview_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'clear_report_export_job_preview_v1 missing';
  END IF;
  IF to_regprocedure('public.store_report_export_job_preview_chunk_v1(uuid, integer, text[], jsonb)') IS NULL THEN
    RAISE EXCEPTION 'store_report_export_job_preview_chunk_v1 missing';
  END IF;
  IF to_regprocedure('public.get_report_export_job_preview_v1(uuid, integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'get_report_export_job_preview_v1 missing';
  END IF;
  IF to_regprocedure('public.list_report_export_jobs_v2(uuid, text, integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'list_report_export_jobs_v2 missing';
  END IF;
  RAISE NOTICE 'detailed_expense_report_preview_v1 migration verified OK';
END;
$verify$;
