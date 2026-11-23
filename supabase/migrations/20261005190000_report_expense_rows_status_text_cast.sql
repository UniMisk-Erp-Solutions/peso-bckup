-- Tally/report workers: compare expense_status enum to text[] statuses safely.
-- (Remote DB uses expense_status enum on expenses.status.)

CREATE OR REPLACE FUNCTION public.report_expense_rows_v1(
  p_organization_id uuid,
  p_statuses        text[],
  p_category        text    DEFAULT NULL,
  p_user_ids        uuid[]  DEFAULT NULL,
  p_date_from       date    DEFAULT NULL,
  p_date_to         date    DEFAULT NULL,
  p_sort_column     text    DEFAULT 'created_at',
  p_cursor          jsonb   DEFAULT NULL,
  p_page_size       integer DEFAULT 250,
  p_with_total      boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_size     integer := LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 500);
  v_sort_col text    := CASE WHEN p_sort_column = 'trip_start' THEN 'trip_start' ELSE 'created_at' END;
  v_cur_val  timestamptz := NULL;
  v_cur_id   uuid    := NULL;
  v_out      jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_cursor IS NOT NULL THEN
    IF jsonb_typeof(p_cursor) <> 'object' THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
    v_cur_val := NULLIF(p_cursor ->> 'v', '')::timestamptz;
    v_cur_id  := NULLIF(p_cursor ->> 'id', '')::uuid;
    IF v_cur_val IS NULL OR v_cur_id IS NULL THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  WITH filtered AS (
    SELECT e.id, e.user_id, e.title, e.total_amount, e.status, e.created_at,
           e.trip_start, e.trip_end, e.category, e.purpose, e.destination,
           e.transaction_number, e.batch_id,
           CASE WHEN v_sort_col = 'trip_start' THEN e.trip_start::timestamptz ELSE e.created_at END AS sort_val
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status::text = ANY (p_statuses)
      AND (p_category IS NULL OR e.category ILIKE p_category)
      AND (p_user_ids IS NULL OR e.user_id = ANY (p_user_ids))
      AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
      AND (p_date_to IS NULL OR e.trip_start <= p_date_to)
      AND (
        p_cursor IS NULL
        OR (CASE WHEN v_sort_col = 'trip_start' THEN e.trip_start::timestamptz ELSE e.created_at END, e.id)
           < (v_cur_val, v_cur_id)
      )
    ORDER BY sort_val DESC, e.id DESC
    LIMIT v_size
  ),
  ids AS (SELECT array_agg(id) AS arr FROM filtered),
  custom AS (
    SELECT public._report_expense_custom_fields_v1(p_organization_id, COALESCE((SELECT arr FROM ids), ARRAY[]::uuid[])) AS map
  ),
  rows_json AS (
    SELECT jsonb_agg(jsonb_build_object(
             'id', f.id,
             'user_id', f.user_id,
             'user_name', COALESCE(pr.name, ''),
             'user_email', COALESCE(pr.email, ''),
             'employee_id', COALESCE(pr.employee_id, ''),
             'user_balance', COALESCE(pr.balance, 0),
             'title', f.title,
             'total_amount', COALESCE(f.total_amount, 0),
             'status', f.status,
             'created_at', f.created_at,
             'trip_start', f.trip_start,
             'trip_end', f.trip_end,
             'category', f.category,
             'purpose', f.purpose,
             'destination', f.destination,
             'transaction_number', f.transaction_number,
             'batch_ref', COALESCE(NULLIF(btrim(eb.label), ''), '-'),
             'custom_fields', COALESCE((SELECT map FROM custom) -> f.id::text, '{}'::jsonb)
           ) ORDER BY f.sort_val DESC, f.id DESC) AS arr,
           count(*) AS n
    FROM filtered f
    LEFT JOIN public.profiles pr ON pr.user_id = f.user_id AND pr.organization_id = p_organization_id
    LEFT JOIN public.expense_batches eb ON eb.id = f.batch_id
  ),
  last_row AS (
    SELECT sort_val, id FROM filtered ORDER BY sort_val ASC, id ASC LIMIT 1
  ),
  tot AS (
    SELECT CASE WHEN COALESCE(p_with_total, false) THEN (
      SELECT count(*) FROM public.expenses e
      WHERE e.organization_id = p_organization_id
        AND e.status::text = ANY (p_statuses)
        AND (p_category IS NULL OR e.category ILIKE p_category)
        AND (p_user_ids IS NULL OR e.user_id = ANY (p_user_ids))
        AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
        AND (p_date_to IS NULL OR e.trip_start <= p_date_to)
    ) END AS total
  )
  SELECT jsonb_build_object(
    'schema_version', 1,
    'snapshot_at', now(),
    'returned', COALESCE((SELECT n FROM rows_json), 0),
    'page_size', v_size,
    'has_more', COALESCE((SELECT n FROM rows_json), 0) = v_size,
    'next_cursor', CASE WHEN COALESCE((SELECT n FROM rows_json), 0) = v_size
                        THEN (SELECT jsonb_build_object('v', sort_val, 'id', id) FROM last_row)
                        ELSE NULL END,
    'total_count', (SELECT total FROM tot),
    'rows', COALESCE((SELECT arr FROM rows_json), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;
