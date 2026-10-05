-- Report preview sort/filter v3 (owner QA polish pass, 2026-09-25).
--
-- get_report_export_job_preview_v2 (already applied, left untouched) sorts the
-- whole frozen report correctly, but lets blanks float to the TOP in some
-- directions: PostgreSQL puts NULL first for DESC, and an empty string first
-- for text ASC. On a report that mixes expense rows with balance-only rows
-- (blank Transaction #, Debit, ...) that made a sorted preview open on a page
-- of empty cells. v3 adds:
--   * blanks LAST for both Asc and Desc, for every column kind
--   * case-insensitive text ordering, and all-digit values (Transaction #,
--     Project ID ...) ordered numerically among themselves WITHOUT changing
--     the displayed value (leading zeros stay in row_data)
--   * parse-safe date/money/filter handling (a malformed cell can never raise)
--   * one ORDER BY definition (a row_number() rank) reused for paging AND for
--     the returned array, so the two can never drift apart again
--   * stable row_index as the final tie-break
-- Same authorization, same validation, same response shape as v2 (schema_version 3).
-- v1 and v2 are untouched. No financial table is read or written.

CREATE OR REPLACE FUNCTION public.get_report_export_job_preview_v3(
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

  IF NOT public.daily_report_caller_can_view_v1(v_job.organization_id, false) THEN
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
$$;

REVOKE ALL ON FUNCTION public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb) IS
  'Excel-style server-side sort/filter VIEW over a completed report''s frozen preview rows. Blanks sort last in both directions; text is case-insensitive with all-digit values ordered numerically (display unchanged); parse-safe; one rank drives paging and output. Same authorization as v1/v2.';

DO $verify$
BEGIN
  IF to_regprocedure('public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'get_report_export_job_preview_v3 missing';
  END IF;
  IF to_regprocedure('public.get_report_export_job_preview_v2(uuid, integer, integer, text, text, jsonb)') IS NULL
     OR to_regprocedure('public.get_report_export_job_preview_v1(uuid, integer, integer)') IS NULL THEN
    RAISE EXCEPTION 'v1/v2 must not have been dropped';
  END IF;
  IF has_function_privilege('anon', 'public.get_report_export_job_preview_v3(uuid, integer, integer, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on get_report_export_job_preview_v3';
  END IF;
  RAISE NOTICE 'report_export_job_preview_v3 migration verified OK';
END;
$verify$;
