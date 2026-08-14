-- =============================================================================
-- Debug Review Queue v1 — independent contract (DOC-080)
--
-- NOT EXECUTED by the change that shipped this file.
--
-- Motivation, proven by read-only diagnostic on 2026-08-01:
--   searching "6174" returned ONE row — transaction 06174, owned by employee 6557 —
--   while all 24 expenses belonging to employee 6174 disappeared. Cause: the client
--   matched transaction_number (present on the row) but could not match employee_id
--   (only present after a profile enrichment call that was returning 504). Identity
--   failure did not merely blank a column; it silently removed 24 rows from search.
--
-- The fix encoded here: employee lookup is a SEPARATE, SUBMIT-DRIVEN server RPC that
-- resolves to an immutable user_id and NEVER matches transaction numbers. The queue
-- then filters on that exact user_id.
--
-- Deliberately independent of the review_queue_*_v2 functions; those are untouched.
--
-- Verified columns only (confirmed against the live schema):
--   expenses(id, organization_id, user_id, status, approval_tier, category, title,
--            purpose, destination, total_amount, transaction_number, batch_id,
--            assigned_engineer_id, assigned_reviewer_id, created_at, updated_at,
--            trip_start, trip_end)
--   profiles(user_id, organization_id, name, email, employee_id, balance, is_active,
--            reporting_engineer_id)
--   organization_memberships(organization_id, user_id, role, is_active)
--   teams(organization_id, manager_user_id, executive_user_id, team_leader_user_id)
--   team_members(organization_id, team_id, user_id)
--   audit_logs(id, action, comment, created_at, expense_id, user_id, organization_id)
--   expense_correction_logs(expense_id, organization_id, created_at)
--
-- All functions: SECURITY DEFINER, SET search_path = '', fully-qualified references,
-- PUBLIC and anon revoked, authenticated only.
-- =============================================================================

-- 1 ── Canonical visible-user scope (ONE definition, reused everywhere) --------

CREATE OR REPLACE FUNCTION public._debug_review_visible_user_ids_v1(
  p_organization_id uuid
)
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH caller AS (
    SELECT m.user_id, m.role::text AS role
    FROM public.organization_memberships m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = p_organization_id
      AND m.is_active = true
      AND m.role::text IN ('engineer','team_leader','executive','admin')
    LIMIT 1
  ),
  tree AS (
    WITH RECURSIVE walk(user_id, depth, path) AS (
      SELECT c.user_id, 0, ARRAY[c.user_id] FROM caller c
      UNION ALL
      SELECT p.user_id, w.depth + 1, w.path || p.user_id
      FROM walk w
      JOIN public.profiles p
        ON p.reporting_engineer_id = w.user_id
       AND p.organization_id = p_organization_id
      WHERE w.depth < 10
        AND NOT p.user_id = ANY(w.path)
    )
    SELECT DISTINCT walk.user_id FROM walk
  ),
  owned_teams AS (
    SELECT t.id
    FROM public.teams t, caller c
    WHERE t.organization_id = p_organization_id
      AND (
           (c.role = 'engineer'    AND t.manager_user_id     = c.user_id)
        OR (c.role = 'executive'   AND t.executive_user_id   = c.user_id)
        OR (c.role = 'team_leader' AND t.team_leader_user_id = c.user_id)
      )
  ),
  team_scope AS (
    SELECT tm.user_id
    FROM public.team_members tm
    JOIN owned_teams ot ON ot.id = tm.team_id
    WHERE tm.organization_id = p_organization_id
  ),
  admin_scope AS (
    SELECT p.user_id FROM public.profiles p, caller c
    WHERE c.role = 'admin' AND p.organization_id = p_organization_id
  )
  SELECT DISTINCT u.user_id FROM (
    SELECT tree.user_id FROM tree
    UNION SELECT team_scope.user_id FROM team_scope
    UNION SELECT admin_scope.user_id FROM admin_scope
  ) u
  WHERE EXISTS (SELECT 1 FROM caller);
$$;

REVOKE ALL ON FUNCTION public._debug_review_visible_user_ids_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_visible_user_ids_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_visible_user_ids_v1(uuid) TO authenticated;


-- 2 ── Reviewer authorization guard -------------------------------------------

CREATE OR REPLACE FUNCTION public._debug_review_assert_reviewer_v1(
  p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = p_organization_id
      AND m.is_active = true
      AND m.role::text IN ('engineer','team_leader','executive','admin')
  ) THEN
    RAISE EXCEPTION 'not an authorized reviewer for this organization'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._debug_review_assert_reviewer_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_assert_reviewer_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_assert_reviewer_v1(uuid) TO authenticated;


-- 3 ── Capability probe --------------------------------------------------------
-- ready = true ONLY when every expected function AND signature exists, so a
-- partially applied migration cannot advertise readiness.

CREATE OR REPLACE FUNCTION public.debug_review_queue_capabilities_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH f AS (
    SELECT
      to_regprocedure('public.search_debug_review_employees_v1(uuid,text,integer)') IS NOT NULL AS employee_search,
      to_regprocedure('public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb)') IS NOT NULL AS page,
      to_regprocedure('public.get_debug_review_filter_options_v1(uuid)') IS NOT NULL AS filters,
      to_regprocedure('public.get_debug_review_expense_detail_v1(uuid,uuid)') IS NOT NULL AS detail
  )
  SELECT jsonb_build_object(
    'contract', 'debug-review-queue',
    'version', 1,
    'ready', (f.employee_search AND f.page AND f.filters AND f.detail),
    'functions', jsonb_build_object(
      'employee_search', f.employee_search,
      'page', f.page,
      'filters', f.filters,
      'detail', f.detail
    ),
    'schema_revision', '20260801140000',
    'server_time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ) FROM f;
$$;

REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.debug_review_queue_capabilities_v1() TO authenticated;


-- 4 ── Employee search — SUBMIT-DRIVEN, NEVER matches transaction numbers ------

CREATE OR REPLACE FUNCTION public.search_debug_review_employees_v1(
  p_organization_id uuid,
  p_query text,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_q     text    := nullif(btrim(coalesce(p_query, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_out   jsonb;
BEGIN
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);

  IF v_q IS NULL THEN
    RETURN jsonb_build_object('contract','debug-review-employee-search','version',1,
                              'query',NULL,'matches','[]'::jsonb);
  END IF;

  -- Only employees who actually have at least one expense inside the reviewer's
  -- authorized scope. This is what prevents identity enumeration.
  WITH visible_expenses AS (
    SELECT e.id, e.user_id, e.status::text AS status, e.approval_tier
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status::text <> 'draft'
      AND (
           e.user_id IN (SELECT v.user_id
                         FROM public._debug_review_visible_user_ids_v1(p_organization_id) v)
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid()
      )
  ),
  counts AS (
    SELECT ve.user_id,
           count(*) AS visible_expense_count,
           count(*) FILTER (
             WHERE ve.status NOT IN ('verified','approved','rejected')
           ) AS actionable_expense_count
    FROM visible_expenses ve
    GROUP BY ve.user_id
  ),
  ranked AS (
    SELECT p.user_id,
           coalesce(nullif(btrim(p.name), ''), 'Unknown employee') AS employee_name,
           p.employee_id,
           p.email AS employee_email,
           CASE WHEN coalesce(p.is_active, true) THEN 'current_profile'
                ELSE 'inactive_profile' END AS identity_source,
           c.visible_expense_count,
           c.actionable_expense_count,
           CASE
             WHEN lower(btrim(coalesce(p.employee_id,''))) = lower(v_q) THEN 'exact_employee_id'
             WHEN lower(btrim(coalesce(p.name,'')))        = lower(v_q) THEN 'exact_employee_name'
             WHEN lower(btrim(coalesce(p.name,''))) LIKE lower(v_q) || '%' THEN 'name_prefix'
             WHEN lower(btrim(coalesce(p.name,''))) LIKE '%' || lower(v_q) || '%' THEN 'name_contains'
             WHEN lower(btrim(coalesce(p.email,'')))       = lower(v_q) THEN 'exact_email'
             ELSE NULL
           END AS match_type
    FROM public.profiles p
    JOIN counts c ON c.user_id = p.user_id
    WHERE p.organization_id = p_organization_id
  )
  SELECT jsonb_build_object(
    'contract','debug-review-employee-search',
    'version',1,
    'query', v_q,
    'matches', coalesce(jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'employee_name', r.employee_name,
        'employee_id', r.employee_id,
        'employee_email', r.employee_email,
        'identity_source', r.identity_source,
        'visible_expense_count', r.visible_expense_count,
        'actionable_expense_count', r.actionable_expense_count,
        'match_type', r.match_type
      ) ORDER BY
        CASE r.match_type
          WHEN 'exact_employee_id'   THEN 1
          WHEN 'exact_employee_name' THEN 2
          WHEN 'name_prefix'         THEN 3
          WHEN 'name_contains'       THEN 4
          WHEN 'exact_email'         THEN 5
          ELSE 9 END,
        r.employee_name), '[]'::jsonb)
  ) INTO v_out
  FROM (SELECT * FROM ranked WHERE match_type IS NOT NULL LIMIT v_limit) r;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.search_debug_review_employees_v1(uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_debug_review_employees_v1(uuid,text,integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.search_debug_review_employees_v1(uuid,text,integer) TO authenticated;

COMMENT ON FUNCTION public.search_debug_review_employees_v1(uuid,text,integer) IS
  'Submit-driven employee lookup. Resolves name/employee_id to an immutable user_id. Never matches transaction numbers (DOC-080).';


-- 5 ── Queue page --------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_debug_review_queue_page_v1(
  p_organization_id uuid,
  p_page_size integer DEFAULT 25,
  p_cursor jsonb DEFAULT NULL,
  p_sort text DEFAULT 'created_desc',
  p_employee_user_id uuid DEFAULT NULL,
  p_general_search text DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_categories text[] DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_actionable_only boolean DEFAULT false,
  p_custom_filters jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_size    integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_sort    text    := coalesce(p_sort, 'created_desc');
  v_search  text    := nullif(btrim(coalesce(p_general_search, '')), '');
  v_c_ts    timestamptz := NULL;
  v_c_date  date        := NULL;
  v_c_amt   numeric     := NULL;
  v_c_id    uuid        := NULL;
  v_out     jsonb;
BEGIN
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);

  IF v_sort NOT IN ('created_desc','created_asc','expense_date_desc',
                    'expense_date_asc','amount_desc','amount_asc') THEN
    RAISE EXCEPTION 'unsupported sort: %', v_sort USING ERRCODE = '22023';
  END IF;

  IF p_custom_filters IS NOT NULL AND jsonb_typeof(p_custom_filters) <> 'array' THEN
    RAISE EXCEPTION 'p_custom_filters must be a JSON array' USING ERRCODE = '22023';
  END IF;

  IF p_cursor IS NOT NULL THEN
    IF jsonb_typeof(p_cursor) <> 'object' THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_c_ts   := nullif(p_cursor->>'created_at','')::timestamptz;
      v_c_date := nullif(p_cursor->>'trip_start','')::date;
      v_c_amt  := nullif(p_cursor->>'total_amount','')::numeric;
      v_c_id   := nullif(p_cursor->>'id','')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END;
  END IF;

  WITH visible AS MATERIALIZED (
    SELECT e.id, e.user_id, e.status::text AS status, e.approval_tier, e.category,
           e.title, e.purpose, e.destination, e.total_amount, e.transaction_number,
           e.batch_id, e.created_at, e.updated_at, e.trip_start
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status::text <> 'draft'
      AND (
           e.user_id IN (SELECT v.user_id
                         FROM public._debug_review_visible_user_ids_v1(p_organization_id) v)
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid()
      )
  ),
  scope_summary AS (
    SELECT count(*) AS assigned_to_me,
           count(*) FILTER (WHERE v.status NOT IN ('verified','approved','rejected')) AS pending_review,
           count(*) FILTER (WHERE v.status IN ('verified','level_1_verified','level_2_verified')) AS verified,
           coalesce(sum(v.total_amount), 0) AS total_amount
    FROM visible v
  ),
  filtered AS MATERIALIZED (
    SELECT r.* FROM visible r
    WHERE
      -- Employee filter is an EXACT immutable user_id. It never consults
      -- transaction_number, which is what caused the 6174 / 06174 collision.
      (p_employee_user_id IS NULL OR r.user_id = p_employee_user_id)
      AND (p_statuses   IS NULL OR r.status   = ANY(p_statuses))
      AND (p_categories IS NULL OR r.category = ANY(p_categories))
      AND (p_date_from  IS NULL OR r.trip_start >= p_date_from)
      AND (p_date_to    IS NULL OR r.trip_start <= p_date_to)
      AND (p_actionable_only = false
           OR r.status NOT IN ('verified','approved','rejected'))
      AND (
        v_search IS NULL
        OR r.transaction_number ILIKE '%' || v_search || '%'
        OR r.title       ILIKE '%' || v_search || '%'
        OR r.purpose     ILIKE '%' || v_search || '%'
        OR r.category    ILIKE '%' || v_search || '%'
        OR r.destination ILIKE '%' || v_search || '%'
        OR r.total_amount::text ILIKE '%' || v_search || '%'
      )
      AND (
        p_custom_filters IS NULL
        OR jsonb_array_length(p_custom_filters) = 0
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_custom_filters) AS cf
          WHERE NOT EXISTS (
            SELECT 1 FROM public.expense_form_field_values fv
            WHERE fv.expense_id = r.id
              AND fv.organization_id = p_organization_id
              AND fv.field_value = ANY(ARRAY(SELECT jsonb_array_elements_text(cf->'values')))
              AND (
                (cf->>'source' = 'template' AND fv.template_id     = (cf->>'field_id')::uuid)
                OR
                (cf->>'source' = 'branch'   AND fv.branch_field_id = (cf->>'field_id')::uuid)
              )
          )
        )
      )
  ),
  tot AS (SELECT count(*) AS filtered_total FROM filtered),
  ordered AS MATERIALIZED (
    SELECT f.*,
           row_number() OVER (
             ORDER BY
               CASE WHEN v_sort='created_desc'      THEN f.created_at  END DESC,
               CASE WHEN v_sort='created_asc'       THEN f.created_at  END ASC,
               CASE WHEN v_sort='expense_date_desc' THEN f.trip_start  END DESC,
               CASE WHEN v_sort='expense_date_asc'  THEN f.trip_start  END ASC,
               CASE WHEN v_sort='amount_desc'       THEN f.total_amount END DESC NULLS LAST,
               CASE WHEN v_sort='amount_asc'        THEN f.total_amount END ASC  NULLS LAST,
               CASE WHEN v_sort IN ('created_asc','expense_date_asc','amount_asc')
                    THEN f.id END ASC,
               f.id DESC
           ) AS rn
    FROM filtered f
    WHERE CASE v_sort
      WHEN 'created_desc'      THEN v_c_id IS NULL OR (f.created_at, f.id) < (v_c_ts, v_c_id)
      WHEN 'created_asc'       THEN v_c_id IS NULL OR (f.created_at, f.id) > (v_c_ts, v_c_id)
      WHEN 'expense_date_desc' THEN v_c_id IS NULL OR (f.trip_start, f.id) < (v_c_date, v_c_id)
      WHEN 'expense_date_asc'  THEN v_c_id IS NULL OR (f.trip_start, f.id) > (v_c_date, v_c_id)
      WHEN 'amount_desc'       THEN v_c_id IS NULL
        OR (coalesce(f.total_amount,'-Infinity'::numeric), f.id)
           < (coalesce(v_c_amt,'-Infinity'::numeric), v_c_id)
      WHEN 'amount_asc'        THEN v_c_id IS NULL
        OR (coalesce(f.total_amount,'Infinity'::numeric), f.id)
           > (coalesce(v_c_amt,'Infinity'::numeric), v_c_id)
      ELSE true END
  ),
  -- page_size + 1 so has_more is exact and a full final page cannot emit a
  -- cursor that leads to an empty page.
  page_plus_one AS MATERIALIZED (
    SELECT o.* FROM ordered o WHERE o.rn <= v_size + 1 ORDER BY o.rn
  ),
  page_rows AS MATERIALIZED (
    SELECT pp.* FROM page_plus_one pp WHERE pp.rn <= v_size
  ),
  page_identity AS MATERIALIZED (
    SELECT p.user_id,
           coalesce(nullif(btrim(p.name), ''), 'Unknown employee') AS employee_name,
           p.email AS employee_email, p.employee_id,
           coalesce(p.balance, 0) AS current_balance,
           CASE WHEN coalesce(p.is_active, true) THEN 'current_profile'
                ELSE 'inactive_profile' END AS identity_source
    FROM public.profiles p
    WHERE p.organization_id = p_organization_id
      AND p.user_id IN (SELECT DISTINCT pr.user_id FROM page_rows pr)
  ),
  page_custom_fields AS MATERIALIZED (
    SELECT c.expense_id,
           jsonb_agg(jsonb_build_object('source',c.source,'field_id',c.field_id,
             'field_key',c.field_key,'label',c.label,'value',c.value)) AS fields
    FROM (
      SELECT fv.expense_id, 'template'::text AS source, t.id AS field_id,
             coalesce(t.field_key, t.id::text) AS field_key,
             coalesce(t.name, t.field_key) AS label, fv.field_value AS value
      FROM public.expense_form_field_values fv
      JOIN public.expense_form_field_templates t ON t.id = fv.template_id
      WHERE fv.organization_id = p_organization_id
        AND fv.expense_id IN (SELECT pr.id FROM page_rows pr)
      UNION ALL
      SELECT fv.expense_id, 'branch', b.id, coalesce(b.field_key, b.id::text),
             coalesce(b.name, b.field_key), fv.field_value
      FROM public.expense_form_field_values fv
      JOIN public.expense_form_field_option_branches b ON b.id = fv.branch_field_id
      WHERE fv.organization_id = p_organization_id
        AND fv.expense_id IN (SELECT pr.id FROM page_rows pr)
    ) c GROUP BY c.expense_id
  ),
  sel_emp AS (
    SELECT jsonb_build_object(
      'user_id', p.user_id,
      'employee_name', coalesce(nullif(btrim(p.name),''),'Unknown employee'),
      'employee_id', p.employee_id,
      'visible_expense_count', (SELECT count(*) FROM visible v WHERE v.user_id = p_employee_user_id),
      'actionable_expense_count', (SELECT count(*) FROM visible v
                                   WHERE v.user_id = p_employee_user_id
                                     AND v.status NOT IN ('verified','approved','rejected'))
    ) AS j
    FROM public.profiles p
    WHERE p_employee_user_id IS NOT NULL
      AND p.organization_id = p_organization_id
      AND p.user_id = p_employee_user_id
  ),
  items AS (
    SELECT jsonb_agg(jsonb_build_object(
             'id', pr.id,
             'transaction_number', pr.transaction_number,
             'batch_id', pr.batch_id,
             'user_id', pr.user_id,
             'employee_name', coalesce(pi.employee_name,'Unknown employee'),
             'employee_email', pi.employee_email,
             'employee_id', pi.employee_id,
             'identity_source', coalesce(pi.identity_source,'unresolved'),
             'identity_issue', CASE WHEN pi.user_id IS NULL THEN 'profile_missing' ELSE NULL END,
             'current_balance', coalesce(pi.current_balance, 0),
             'title', pr.title, 'purpose', pr.purpose, 'category', pr.category,
             'destination', pr.destination, 'total_amount', pr.total_amount,
             'status', pr.status, 'approval_tier', pr.approval_tier,
             'created_at', pr.created_at, 'trip_start', pr.trip_start,
             'is_resubmitted', EXISTS (SELECT 1 FROM public.audit_logs al
                WHERE al.expense_id = pr.id AND al.action = 'expense_resubmitted'),
             'was_reviewer_corrected', EXISTS (SELECT 1 FROM public.expense_correction_logs cl
                WHERE cl.expense_id = pr.id AND cl.organization_id = p_organization_id),
             'is_actionable', pr.status NOT IN ('verified','approved','rejected'),
             'custom_fields', coalesce(pcf.fields, '[]'::jsonb)
           ) ORDER BY pr.rn) AS arr,
           count(*) AS n,
           count(*) FILTER (WHERE pi.user_id IS NOT NULL) AS resolved,
           count(*) FILTER (WHERE pi.user_id IS NULL) AS unresolved
    FROM page_rows pr
    LEFT JOIN page_identity pi ON pi.user_id = pr.user_id
    LEFT JOIN page_custom_fields pcf ON pcf.expense_id = pr.id
  ),
  last_row AS (
    SELECT pr.created_at, pr.trip_start, pr.total_amount, pr.id
    FROM page_rows pr ORDER BY pr.rn DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'contract','debug-review-queue',
    'version',1,
    'request', jsonb_build_object(
      'employee_user_id', p_employee_user_id,
      'general_search', v_search,
      'sort', v_sort,
      'page_size', v_size),
    'selected_employee', (SELECT j FROM sel_emp),
    'scope_summary', (SELECT to_jsonb(s) FROM scope_summary s),
    'filtered_total', (SELECT filtered_total FROM tot),
    'has_more', (SELECT count(*) FROM page_plus_one) > v_size,
    'next_cursor', CASE WHEN (SELECT count(*) FROM page_plus_one) > v_size
      THEN (SELECT jsonb_build_object('created_at', lr.created_at, 'trip_start', lr.trip_start,
                                      'total_amount', lr.total_amount, 'id', lr.id)
            FROM last_row lr)
      ELSE NULL END,
    'items', coalesce((SELECT arr FROM items), '[]'::jsonb),
    'diagnostics', jsonb_build_object(
      'page_returned', coalesce((SELECT n FROM items), 0),
      'identity_resolved', coalesce((SELECT resolved FROM items), 0),
      'identity_unresolved', coalesce((SELECT unresolved FROM items), 0))
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) TO authenticated;


-- 6 ── Filter options ----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_debug_review_filter_options_v1(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_out jsonb;
BEGIN
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);

  WITH visible AS (
    SELECT e.id, e.user_id, e.category
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status::text <> 'draft'
      AND (
           e.user_id IN (SELECT v.user_id
                         FROM public._debug_review_visible_user_ids_v1(p_organization_id) v)
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid()
      )
  )
  SELECT jsonb_build_object(
    'contract','debug-review-filter-options',
    'version',1,
    'statuses', to_jsonb(ARRAY['submitted','edited','under_review','level_1_verified',
                               'level_2_verified','verified','approved','rejected']),
    'sorts', to_jsonb(ARRAY['created_desc','created_asc','expense_date_desc',
                            'expense_date_asc','amount_desc','amount_asc']),
    'time_periods', to_jsonb(ARRAY['all','week','month','year']),
    'categories', coalesce((SELECT jsonb_agg(DISTINCT v.category) FROM visible v
                            WHERE v.category IS NOT NULL), '[]'::jsonb),
    -- Includes directly-assigned submitters, not only the reporting tree.
    'employees', coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'user_id', p.user_id,
                     'employee_name', coalesce(nullif(btrim(p.name),''),'Unknown employee'),
                     'employee_id', p.employee_id))
                   FROM public.profiles p
                   WHERE p.organization_id = p_organization_id
                     AND p.user_id IN (SELECT DISTINCT v.user_id FROM visible v)), '[]'::jsonb),
    'custom_fields', coalesce((SELECT jsonb_agg(d) FROM (
        SELECT jsonb_build_object('source','template','field_id',t.id,
                 'field_key',coalesce(t.field_key,t.id::text),
                 'label',coalesce(t.name,t.field_key),'options',t.options) AS d
        FROM public.expense_form_field_templates t
        WHERE t.organization_id = p_organization_id
        UNION ALL
        SELECT jsonb_build_object('source','branch','field_id',b.id,
                 'field_key',coalesce(b.field_key,b.id::text),
                 'label',coalesce(b.name,b.field_key),'options',b.options)
        FROM public.expense_form_field_option_branches b
        WHERE b.organization_id = p_organization_id) q), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_filter_options_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_filter_options_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_filter_options_v1(uuid) TO authenticated;


-- 7 ── Detail ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_debug_review_expense_detail_v1(
  p_organization_id uuid,
  p_expense_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_out jsonb; v_ok boolean;
BEGIN
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);

  SELECT EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = p_expense_id
      AND e.organization_id = p_organization_id
      AND (
           e.user_id IN (SELECT v.user_id
                         FROM public._debug_review_visible_user_ids_v1(p_organization_id) v)
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid()
      )
  ) INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'expense not visible to this reviewer' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'contract','debug-review-expense-detail',
    'version',1,
    'expense', to_jsonb(e),
    'employee', coalesce((SELECT jsonb_build_object(
        'user_id',p.user_id,
        'employee_name',coalesce(nullif(btrim(p.name),''),'Unknown employee'),
        'employee_id',p.employee_id,'employee_email',p.email,
        'current_balance',coalesce(p.balance,0),
        'identity_source', CASE WHEN coalesce(p.is_active,true)
                                THEN 'current_profile' ELSE 'inactive_profile' END)
      FROM public.profiles p
      WHERE p.user_id = e.user_id AND p.organization_id = p_organization_id),
      jsonb_build_object('employee_name','Unknown employee','identity_source','unresolved',
                         'identity_issue','profile_missing')),
    'custom_fields', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'source',c.source,'field_id',c.field_id,'field_key',c.field_key,
        'label',c.label,'value',c.value)) FROM (
        SELECT 'template'::text AS source, t.id AS field_id,
               coalesce(t.field_key,t.id::text) AS field_key,
               coalesce(t.name,t.field_key) AS label, fv.field_value AS value
        FROM public.expense_form_field_values fv
        JOIN public.expense_form_field_templates t ON t.id = fv.template_id
        WHERE fv.expense_id = e.id AND fv.organization_id = p_organization_id
        UNION ALL
        SELECT 'branch', b.id, coalesce(b.field_key,b.id::text),
               coalesce(b.name,b.field_key), fv.field_value
        FROM public.expense_form_field_values fv
        JOIN public.expense_form_field_option_branches b ON b.id = fv.branch_field_id
        WHERE fv.expense_id = e.id AND fv.organization_id = p_organization_id) c),
      '[]'::jsonb),
    'attachments', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',a.id,'filename',a.filename,'content_type',a.content_type,'file_url',a.file_url))
      FROM public.attachments a WHERE a.expense_id = e.id), '[]'::jsonb),
    'timeline', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',al.id,'action',al.action,'comment',al.comment,
        'user_id',al.user_id,'created_at',al.created_at) ORDER BY al.created_at)
      FROM public.audit_logs al WHERE al.expense_id = e.id), '[]'::jsonb),
    'corrections', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',cl.id,'edited_by',cl.edited_by,'reason',cl.reason,'created_at',cl.created_at)
        ORDER BY cl.created_at DESC)
      FROM public.expense_correction_logs cl
      WHERE cl.expense_id = e.id AND cl.organization_id = p_organization_id), '[]'::jsonb),
    'is_actionable', (e.status::text NOT IN ('verified','approved','rejected'))
  ) INTO v_out
  FROM public.expenses e
  WHERE e.id = p_expense_id;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_expense_detail_v1(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_expense_detail_v1(uuid,uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_expense_detail_v1(uuid,uuid) TO authenticated;
