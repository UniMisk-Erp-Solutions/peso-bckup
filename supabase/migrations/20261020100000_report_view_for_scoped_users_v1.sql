-- View Report / Report History for scoped (non-admin) report users (DOC-147).
--
-- CAUSE: get_report_export_job_preview_v3 and list_report_export_jobs_v4 only
-- allowed admin/accountant callers (daily_report_caller_can_view_v1(org, false)).
-- A manager or employee could generate and download their own report (table RLS
-- allows the requester) but the on-page preview RPC raised 42501, which the UI
-- swallowed, so no preview / "View Report" ever appeared.
--
-- FIX (authorization only; no data or report content changes):
--   * preview: admin/accountant unchanged; otherwise the caller must be the job's
--     requester AND allowed to generate scoped reports (team-scoped check).
--   * history list: admin/accountant unchanged (whole org); scoped viewers see
--     only the jobs they requested.
-- The rows being read were frozen from the server-derived scope when the job was
-- created (20261019100000_secure_report_scope_v1.sql), so this cannot widen scope.

CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v3(p_job_id uuid, p_page integer DEFAULT 1, p_page_size integer DEFAULT 50, p_sort_column text DEFAULT NULL::text, p_sort_direction text DEFAULT 'asc'::text, p_column_filters jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid := auth.uid();
  v_job            public.report_export_jobs%ROWTYPE;
  v_page           integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size      integer := LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 200);
  v_direction      text := lower(COALESCE(p_sort_direction, 'asc'));
  v_sort_kind      text := NULL;
  v_total          integer;
  v_filtered_total integer;
  v_rows           jsonb;
  v_filter_key     text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_job FROM public.report_export_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report not found' USING ERRCODE = '42704';
  END IF;

  -- Admin / accountant: any report in the organization (unchanged).
  -- Everyone else who may generate scoped reports (manager, team leader,
  -- executive, employee with teams_enabled): ONLY a report they requested
  -- themselves. Its rows were frozen from the server-derived scope at
  -- creation time, so reading them back cannot widen access.
  IF NOT (
    public.daily_report_caller_can_view_v1(v_job.organization_id, false)
    OR (v_job.requested_by = v_uid
        AND public.daily_report_caller_can_view_v1(v_job.organization_id, true))
  ) THEN
    RAISE EXCEPTION 'not permitted to view this report' USING ERRCODE = '42501';
  END IF;

  IF v_job.status <> 'completed' THEN
    RETURN jsonb_build_object(
      'schema_version', 3, 'ready', false, 'reason', 'not_completed',
      'columns', '[]'::jsonb, 'total_count', 0, 'filtered_total_count', 0,
      'page', v_page, 'page_size', v_page_size, 'rows', '[]'::jsonb
    );
  END IF;

  IF v_job.preview_columns IS NULL THEN
    RETURN jsonb_build_object(
      'schema_version', 3, 'ready', false, 'reason', 'no_preview_available',
      'columns', '[]'::jsonb, 'total_count', 0, 'filtered_total_count', 0,
      'page', v_page, 'page_size', v_page_size, 'rows', '[]'::jsonb
    );
  END IF;

  IF v_direction NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'invalid sort direction' USING ERRCODE = '22023';
  END IF;

  IF p_sort_column IS NOT NULL THEN
    IF NOT (p_sort_column = ANY (v_job.preview_columns)) THEN
      RAISE EXCEPTION 'unknown sort column' USING ERRCODE = '22023';
    END IF;
    v_sort_kind := CASE
      WHEN p_sort_column = 'Date' THEN 'date'
      WHEN p_sort_column IN ('Credit', 'Debit', 'Opening Balance', 'Closing Balance') THEN 'money'
      ELSE 'text'
    END;
  END IF;

  IF p_column_filters IS NOT NULL THEN
    IF jsonb_typeof(p_column_filters) <> 'object' THEN
      RAISE EXCEPTION 'malformed column filters' USING ERRCODE = '22023';
    END IF;
    FOR v_filter_key IN SELECT jsonb_object_keys(p_column_filters) LOOP
      IF NOT (v_filter_key = ANY (v_job.preview_columns)) THEN
        RAISE EXCEPTION 'unknown filter column: %', v_filter_key USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT count(*) INTO v_total FROM public.report_export_job_rows WHERE job_id = p_job_id;

  WITH base AS (
    SELECT row_index, row_data
    FROM public.report_export_job_rows
    WHERE job_id = p_job_id
  ),
  filtered AS (
    SELECT b.row_index, b.row_data
    FROM base b
    WHERE p_column_filters IS NULL OR NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_column_filters) AS f(col, spec)
      WHERE
        (spec ? 'contains' AND NOT (COALESCE(b.row_data->>f.col, '') ILIKE '%' || (spec->>'contains') || '%'))
        OR (spec ? 'from' AND COALESCE(
              CASE WHEN (b.row_data->>f.col) ~ '^\d{2}-\d{2}-\d{4}$'
                   THEN to_date(b.row_data->>f.col, 'DD-MM-YYYY') < (spec->>'from')::date END,
              true))
        OR (spec ? 'to' AND COALESCE(
              CASE WHEN (b.row_data->>f.col) ~ '^\d{2}-\d{2}-\d{4}$'
                   THEN to_date(b.row_data->>f.col, 'DD-MM-YYYY') > (spec->>'to')::date END,
              true))
        OR (spec ? 'min' AND COALESCE(
              CASE WHEN regexp_replace(COALESCE(b.row_data->>f.col, ''), '[^0-9.\-]', '', 'g') ~ '^-?\d+(\.\d+)?$'
                   THEN regexp_replace(b.row_data->>f.col, '[^0-9.\-]', '', 'g')::numeric < (spec->>'min')::numeric END,
              true))
        OR (spec ? 'max' AND COALESCE(
              CASE WHEN regexp_replace(COALESCE(b.row_data->>f.col, ''), '[^0-9.\-]', '', 'g') ~ '^-?\d+(\.\d+)?$'
                   THEN regexp_replace(b.row_data->>f.col, '[^0-9.\-]', '', 'g')::numeric > (spec->>'max')::numeric END,
              true))
    )
  ),
  keyed AS (
    SELECT
      f.row_index,
      f.row_data,
      CASE WHEN v_sort_kind = 'date'
                AND (f.row_data->>p_sort_column) ~ '^\d{2}-\d{2}-\d{4}$'
           THEN to_date(f.row_data->>p_sort_column, 'DD-MM-YYYY') END AS k_date,
      CASE WHEN v_sort_kind = 'money'
                AND regexp_replace(COALESCE(f.row_data->>p_sort_column, ''), '[^0-9.\-]', '', 'g') ~ '^-?\d+(\.\d+)?$'
           THEN regexp_replace(f.row_data->>p_sort_column, '[^0-9.\-]', '', 'g')::numeric END AS k_num,
      CASE WHEN v_sort_kind = 'text' THEN
             CASE WHEN btrim(COALESCE(f.row_data->>p_sort_column, '')) ~ '^\d+$'
                  THEN lpad(btrim(f.row_data->>p_sort_column), 40, '0')
                  ELSE lower(btrim(COALESCE(f.row_data->>p_sort_column, '')))
             END
      END AS k_txt
    FROM filtered f
  ),
  ranked AS (
    SELECT
      k.row_index,
      k.row_data,
      row_number() OVER (
        ORDER BY
          -- blanks always last, whatever the direction
          CASE
            WHEN v_sort_kind = 'date'  AND k.k_date IS NULL THEN 1
            WHEN v_sort_kind = 'money' AND k.k_num  IS NULL THEN 1
            WHEN v_sort_kind = 'text'  AND k.k_txt = ''     THEN 1
            ELSE 0
          END,
          CASE WHEN v_direction = 'asc'  THEN k.k_date END ASC,
          CASE WHEN v_direction = 'desc' THEN k.k_date END DESC,
          CASE WHEN v_direction = 'asc'  THEN k.k_num  END ASC,
          CASE WHEN v_direction = 'desc' THEN k.k_num  END DESC,
          CASE WHEN v_direction = 'asc'  THEN k.k_txt  END ASC,
          CASE WHEN v_direction = 'desc' THEN k.k_txt  END DESC,
          k.row_index ASC
      ) AS rn,
      count(*) OVER () AS n
    FROM keyed k
  ),
  paged AS (
    SELECT * FROM ranked
    WHERE rn > (v_page - 1) * v_page_size AND rn <= v_page * v_page_size
  )
  SELECT
    COALESCE((SELECT max(n) FROM ranked), 0),
    COALESCE(jsonb_agg(p.row_data ORDER BY p.rn), '[]'::jsonb)
  INTO v_filtered_total, v_rows
  FROM paged p;

  RETURN jsonb_build_object(
    'schema_version', 3,
    'ready', true,
    'reason', NULL,
    'columns', to_jsonb(v_job.preview_columns),
    'total_count', v_total,
    'filtered_total_count', COALESCE(v_filtered_total, 0),
    'page', v_page,
    'page_size', v_page_size,
    'rows', v_rows
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_report_export_jobs_v4(p_organization_id uuid, p_report_type text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_uid    uuid := auth.uid();
  v_out    jsonb;
  v_own_only boolean := false;
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
  IF public.daily_report_caller_can_view_v1(p_organization_id, false) THEN
    v_own_only := false;            -- admin / accountant: whole organization (unchanged)
  ELSIF public.daily_report_caller_can_view_v1(p_organization_id, true) THEN
    v_own_only := true;             -- scoped viewers: their own generated reports only
  ELSE
    RAISE EXCEPTION 'not permitted to view this report' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'schema_version', 4,
    'offset', v_offset,
    'limit', v_limit,
    'total_count', (
      SELECT count(*)::integer FROM public.report_export_jobs
      WHERE organization_id = p_organization_id AND report_type = p_report_type
        AND (NOT v_own_only OR requested_by = v_uid)
    ),
    'jobs', COALESCE(jsonb_agg(jsonb_build_object(
      'id', j.id,
      'status', j.status,
      'filename', j.filename,
      'storage_path', j.storage_path,
      'file_size_bytes', j.file_size_bytes,
      'row_count', j.progress_current,
      'progress_current', j.progress_current,
      'progress_total', j.progress_total,
      'created_at', j.created_at,
      'started_at', j.started_at,
      'completed_at', j.completed_at,
      'expires_at', j.expires_at,
      'requested_by_name', COALESCE(NULLIF(btrim(COALESCE(p.name, '')), ''), 'Unknown user'),
      'requested_by_me', (j.requested_by = v_uid),
      -- Only a failed job exposes its (already sanitised) reason.
      'error_message_safe', CASE WHEN j.status = 'failed' THEN j.error_message_safe ELSE NULL END,
      'stale', (
        j.status = 'running'
        AND COALESCE(j.worker_heartbeat_at, j.started_at, j.created_at) < now() - interval '5 minutes'
      ),
      'downloadable', (
        j.status = 'completed'
        AND j.storage_path IS NOT NULL
        AND (j.expires_at IS NULL OR j.expires_at > now())
        AND EXISTS (
          SELECT 1 FROM storage.objects o
          WHERE o.bucket_id = 'generated-reports' AND o.name = j.storage_path
        )
      ),
      'has_preview', (j.preview_columns IS NOT NULL),
      'parameters', COALESCE(j.parameters, '{}'::jsonb),
      'employee_display', CASE
        WHEN NULLIF(j.parameters->>'user_id', '') IS NULL THEN NULL
        ELSE COALESCE(NULLIF(btrim(COALESCE(ep.name, '')), ''), 'Employee') ||
             CASE WHEN NULLIF(btrim(COALESCE(ep.employee_id, '')), '') IS NOT NULL
                  THEN ' (' || ep.employee_id || ')'
                  ELSE ''
             END
      END
    ) ORDER BY j.created_at DESC), '[]'::jsonb)
  ) INTO v_out
  FROM (
    SELECT *
    FROM public.report_export_jobs
    WHERE organization_id = p_organization_id
      AND report_type = p_report_type
      AND (NOT v_own_only OR requested_by = v_uid)
    ORDER BY created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) j
  LEFT JOIN public.profiles p ON p.user_id = j.requested_by AND p.organization_id = j.organization_id
  LEFT JOIN public.profiles ep
    ON ep.user_id = NULLIF(j.parameters->>'user_id', '')::uuid
   AND ep.organization_id = j.organization_id;

  RETURN v_out;
END;
$function$;
