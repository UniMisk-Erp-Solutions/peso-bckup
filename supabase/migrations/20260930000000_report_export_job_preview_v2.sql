-- Report preview: Excel-style server-side sort/filter (owner "final preview
-- UX + memory provenance" pass, 2026-09-23).
--
-- WHY A NEW RPC, NOT AN EDIT TO V1
-- get_report_export_job_preview_v1 is already live in Production. This adds
-- get_report_export_job_preview_v2 (same authorization, same frozen-row
-- source) with three new inputs: p_sort_column, p_sort_direction,
-- p_column_filters. v1 is completely untouched.
--
-- WHY THIS IS A VIEW, NOT A REGENERATION
-- report_export_job_rows is the immutable, frozen snapshot the CSV was built
-- from (DOC-131) -- this function only changes the ORDER and SUBSET of rows
-- READ from it for on-page inspection. It never writes to
-- report_export_job_rows, never touches the uploaded CSV, and never
-- recalculates Opening/Closing Balance -- those values stay exactly as
-- frozen, attached to their own row, regardless of how the view is sorted.
--
-- COLUMN TYPE CLASSIFICATION (generic, not org-specific)
-- Only the report's own FIXED column names are classified as
-- date/money -- "Date" and "Credit"/"Debit"/"Opening Balance"/"Closing
-- Balance". Every other column, INCLUDING every dynamic custom-field
-- column that varies per organization, defaults to plain text sort/filter.
-- Nothing here is keyed on an organization id or a specific custom field
-- name.
--
-- NO DYNAMIC SQL: sort column/direction and filter columns are validated
-- against p_job.preview_columns (a fixed, already-frozen list) before any
-- comparison is built, and every comparison is a parameterized CASE
-- expression -- never string-interpolated into a query, so there is no SQL
-- injection surface regardless of what a caller passes as a filter value.

CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v2(
  p_job_id          uuid,
  p_page            integer DEFAULT 1,
  p_page_size       integer DEFAULT 50,
  p_sort_column     text    DEFAULT NULL,
  p_sort_direction  text    DEFAULT 'asc',
  p_column_filters  jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_job          public.report_export_jobs%ROWTYPE;
  v_page         integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size    integer := LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 200);
  v_direction    text := lower(COALESCE(p_sort_direction, 'asc'));
  v_sort_kind    text := NULL; -- 'date' | 'money' | 'text' | NULL (no sort)
  v_total        integer;
  v_filtered_total integer;
  v_rows         jsonb;
  v_filter_key   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_job FROM public.report_export_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report not found' USING ERRCODE = '42704';
  END IF;

  -- Identical authorization to v1 -- resolved from the job's OWN stored
  -- organization_id, never anything client-supplied.
  IF NOT public.daily_report_caller_can_view_v1(v_job.organization_id, false) THEN
    RAISE EXCEPTION 'not permitted to view this report' USING ERRCODE = '42501';
  END IF;

  IF v_job.status <> 'completed' THEN
    RETURN jsonb_build_object(
      'schema_version', 2, 'ready', false, 'reason', 'not_completed',
      'columns', '[]'::jsonb, 'total_count', 0, 'filtered_total_count', 0,
      'page', v_page, 'page_size', v_page_size, 'rows', '[]'::jsonb
    );
  END IF;

  IF v_job.preview_columns IS NULL THEN
    RETURN jsonb_build_object(
      'schema_version', 2, 'ready', false, 'reason', 'no_preview_available',
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
        OR (spec ? 'from' AND (
              (b.row_data->>f.col) !~ '^\d{2}-\d{2}-\d{4}$'
              OR to_date(b.row_data->>f.col, 'DD-MM-YYYY') < (spec->>'from')::date
            ))
        OR (spec ? 'to' AND (
              (b.row_data->>f.col) !~ '^\d{2}-\d{2}-\d{4}$'
              OR to_date(b.row_data->>f.col, 'DD-MM-YYYY') > (spec->>'to')::date
            ))
        OR (spec ? 'min' AND (
              NULLIF(regexp_replace(COALESCE(b.row_data->>f.col, ''), '[^0-9.\-]', '', 'g'), '') IS NULL
              OR NULLIF(regexp_replace(b.row_data->>f.col, '[^0-9.\-]', '', 'g'), '')::numeric < (spec->>'min')::numeric
            ))
        OR (spec ? 'max' AND (
              NULLIF(regexp_replace(COALESCE(b.row_data->>f.col, ''), '[^0-9.\-]', '', 'g'), '') IS NULL
              OR NULLIF(regexp_replace(b.row_data->>f.col, '[^0-9.\-]', '', 'g'), '')::numeric > (spec->>'max')::numeric
            ))
    )
  ),
  counted AS (
    SELECT count(*) AS n FROM filtered
  ),
  paged AS (
    SELECT * FROM filtered f
    ORDER BY
      -- Exactly one of these six is non-NULL for every row when a sort is
      -- active; all six are NULL (pure ties) when p_sort_column is NULL, so
      -- the final row_index tiebreak alone decides order -- the canonical
      -- generation order (§25).
      CASE WHEN v_sort_kind = 'date'  AND v_direction = 'asc'  THEN to_date(f.row_data->>p_sort_column, 'DD-MM-YYYY') END ASC,
      CASE WHEN v_sort_kind = 'date'  AND v_direction = 'desc' THEN to_date(f.row_data->>p_sort_column, 'DD-MM-YYYY') END DESC,
      CASE WHEN v_sort_kind = 'money' AND v_direction = 'asc'  THEN NULLIF(regexp_replace(f.row_data->>p_sort_column, '[^0-9.\-]', '', 'g'), '')::numeric END ASC,
      CASE WHEN v_sort_kind = 'money' AND v_direction = 'desc' THEN NULLIF(regexp_replace(f.row_data->>p_sort_column, '[^0-9.\-]', '', 'g'), '')::numeric END DESC,
      CASE WHEN v_sort_kind = 'text'  AND v_direction = 'asc'  THEN f.row_data->>p_sort_column END ASC,
      CASE WHEN v_sort_kind = 'text'  AND v_direction = 'desc' THEN f.row_data->>p_sort_column END DESC,
      f.row_index ASC
    LIMIT v_page_size OFFSET (v_page - 1) * v_page_size
  )
  -- Re-apply the SAME ordering here: jsonb_agg's own ORDER BY is what fixes
  -- the order of the returned JSON array, and it does NOT inherit the
  -- ordering that `paged` used to pick which rows made the page (that
  -- ORDER BY only decided the LIMIT/OFFSET window). Without repeating it,
  -- every sort request would still select the mathematically correct page
  -- of rows but silently render them back in canonical row_index order.
  SELECT (SELECT n FROM counted), COALESCE(jsonb_agg(p.row_data ORDER BY
      CASE WHEN v_sort_kind = 'date'  AND v_direction = 'asc'  THEN to_date(p.row_data->>p_sort_column, 'DD-MM-YYYY') END ASC,
      CASE WHEN v_sort_kind = 'date'  AND v_direction = 'desc' THEN to_date(p.row_data->>p_sort_column, 'DD-MM-YYYY') END DESC,
      CASE WHEN v_sort_kind = 'money' AND v_direction = 'asc'  THEN NULLIF(regexp_replace(p.row_data->>p_sort_column, '[^0-9.\-]', '', 'g'), '')::numeric END ASC,
      CASE WHEN v_sort_kind = 'money' AND v_direction = 'desc' THEN NULLIF(regexp_replace(p.row_data->>p_sort_column, '[^0-9.\-]', '', 'g'), '')::numeric END DESC,
      CASE WHEN v_sort_kind = 'text'  AND v_direction = 'asc'  THEN p.row_data->>p_sort_column END ASC,
      CASE WHEN v_sort_kind = 'text'  AND v_direction = 'desc' THEN p.row_data->>p_sort_column END DESC,
      p.row_index ASC
    ), '[]'::jsonb)
  INTO v_filtered_total, v_rows
  FROM paged p;

  RETURN jsonb_build_object(
    'schema_version', 2,
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
$$;

REVOKE ALL ON FUNCTION public.get_report_export_job_preview_v2(uuid, integer, integer, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_report_export_job_preview_v2(uuid, integer, integer, text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_report_export_job_preview_v2(uuid, integer, integer, text, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.get_report_export_job_preview_v2(uuid, integer, integer, text, text, jsonb) IS
  'Excel-style server-side sort/filter VIEW over a completed report''s frozen'
  ' preview rows (report_export_job_rows) -- never regenerates, never'
  ' rewrites the CSV, never recalculates Opening/Closing Balance. Same'
  ' authorization as v1 (daily_report_caller_can_view_v1, resolved from the'
  ' job''s own organization_id). Sort/filter columns are validated against'
  ' the job''s own preview_columns; no dynamic SQL is ever built from a'
  ' caller-supplied value.';

DO $verify$
BEGIN
  IF to_regprocedure('public.get_report_export_job_preview_v2(uuid, integer, integer, text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'get_report_export_job_preview_v2 missing';
  END IF;
  IF to_regprocedure('public.get_report_export_job_preview_v1(uuid, integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'get_report_export_job_preview_v1 missing (must not have been dropped)';
  END IF;
  IF has_function_privilege('anon', 'public.get_report_export_job_preview_v2(uuid, integer, integer, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on get_report_export_job_preview_v2';
  END IF;
  RAISE NOTICE 'report_export_job_preview_v2 migration verified OK';
END;
$verify$;
