-- =============================================================================
-- Review Queue — KPI scope, conditional filter metadata, page anchor (DOC-080)
--
-- ADDITIVE. 20260801140000 and 20260801150000 are already applied to the shared
-- database (capabilities: ready=true, schema_revision=20260801150000), so neither
-- is rewritten. Everything here is a CREATE OR REPLACE of new or existing
-- functions plus one new function. No table DDL, no data changes.
--
-- Three defects this corrects, all observed on the live page:
--
--  1. KPI DISAGREEMENT. "Assigned to Me" showed 5,674 while the unfiltered table
--     showed 7,450. 20260801150000 computed assigned_to_me as
--     "assigned_reviewer_id = me OR assigned_engineer_id = me", which is the
--     DIRECT-assignment count, while the list shows the whole reviewer-visible
--     scope (hierarchy + teams + direct). Two different questions rendered as one
--     number. The card now reports the complete visible scope — the same
--     population the list pages through — and the direct count is preserved
--     separately as `directly_assigned` for anyone who needs it.
--
--  2. DUPLICATE CONDITIONAL FILTERS. get_debug_review_filter_options_v1 returned
--     every template UNION ALL every option branch with no parent information, so
--     the client rendered one dropdown per branch row — hence ten-plus identical
--     "Project ID" controls. Branches are a TREE: the response now carries
--     parent_template_id, parent_branch_id, parent_option_value, display_order,
--     a cycle-safe recursive depth and is_root, so the client can show a child
--     only when its parent's value is actually selected.
--
--  3. NO RANDOM PAGE ACCESS. Keyset paging cannot reach an unvisited page from
--     the current cursor alone. get_debug_review_queue_page_anchor_v1 resolves a
--     target page to the cursor immediately preceding it. Locating a position
--     fundamentally requires counting, so this — and ONLY this — function uses
--     row_number over an id+sort-key relation. The ordinary Next/Previous flow
--     stays pure keyset with no OFFSET.
--
-- Anchor/list parity is structural, not asserted: both call the single helper
-- _debug_review_keyed_scope_v1, so the visible scope, every filter predicate,
-- the sort key, null handling and the uuid tie-breaker cannot drift apart.
--
-- All functions: SECURITY DEFINER, SET search_path = '', fully-qualified,
-- PUBLIC and anon revoked, authenticated only.
-- =============================================================================


-- 1 ── THE canonical filtered + keyed relation -------------------------------
-- One definition of "which rows, in what order". Reused by the page RPC and the
-- anchor RPC so a filter can never apply to one and not the other.

CREATE OR REPLACE FUNCTION public._debug_review_keyed_scope_v1(
  p_organization_id uuid,
  p_sort text,
  p_employee_user_id uuid,
  p_general_search text,
  p_statuses text[],
  p_categories text[],
  p_date_from date,
  p_date_to date,
  p_actionable_only boolean,
  p_custom_filters jsonb
)
RETURNS TABLE(expense_id uuid, sk numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ctx AS (
    SELECT public._debug_review_caller_context_v1(p_organization_id) AS j
  ),
  handoff AS (
    SELECT h.expense_id FROM public._debug_review_handoff_ids_v1(p_organization_id) h
  ),
  visible AS MATERIALIZED (
    SELECT e.id, e.user_id, e.status::text AS status, e.approval_tier, e.category,
           e.title, e.purpose, e.destination, e.total_amount, e.transaction_number,
           e.created_at, e.trip_start,
           e.assigned_reviewer_id, e.assigned_engineer_id,
           EXISTS (SELECT 1 FROM handoff h WHERE h.expense_id = e.id) AS handoff
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
  filtered AS MATERIALIZED (
    SELECT r.id, r.created_at, r.trip_start, r.total_amount
    FROM visible r, ctx
    WHERE
      -- EXACT immutable user_id. Never consults transaction_number.
      (p_employee_user_id IS NULL OR r.user_id = p_employee_user_id)
      AND (p_statuses   IS NULL OR r.status   = ANY(p_statuses))
      AND (p_categories IS NULL OR r.category = ANY(p_categories))
      AND (p_date_from  IS NULL OR r.trip_start >= p_date_from)
      AND (p_date_to    IS NULL OR r.trip_start <= p_date_to)
      AND (
        coalesce(p_actionable_only, false) = false
        OR (public._debug_review_actionability_v1(
              ctx.j->>'role', (ctx.j->>'caller_user_id')::uuid,
              r.status, r.approval_tier,
              r.assigned_reviewer_id, r.assigned_engineer_id,
              (ctx.j->>'hierarchy_enabled')::boolean,
              (ctx.j->>'team_leader_enabled')::boolean,
              (ctx.j->>'executive_enabled')::boolean,
              r.handoff)->>'is_actionable')::boolean
      )
      AND (
        nullif(btrim(coalesce(p_general_search, '')), '') IS NULL
        OR r.transaction_number ILIKE '%' || btrim(p_general_search) || '%'
        OR r.title       ILIKE '%' || btrim(p_general_search) || '%'
        OR r.purpose     ILIKE '%' || btrim(p_general_search) || '%'
        OR r.category    ILIKE '%' || btrim(p_general_search) || '%'
        OR r.destination ILIKE '%' || btrim(p_general_search) || '%'
        OR r.total_amount::text ILIKE '%' || btrim(p_general_search) || '%'
      )
      AND (
        p_custom_filters IS NULL
        OR jsonb_array_length(p_custom_filters) = 0
        -- AND across fields, OR within one field's values.
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
  )
  -- ONE finite, non-null sort key folding direction and null policy together, so
  -- every sort uses the same ascending, never-NULL comparison and NULLs land last.
  SELECT f.id,
         CASE p_sort
           WHEN 'created_desc'      THEN -coalesce(extract(epoch FROM f.created_at)::numeric, -1e30)
           WHEN 'created_asc'       THEN  coalesce(extract(epoch FROM f.created_at)::numeric,  1e30)
           WHEN 'expense_date_desc' THEN -coalesce(extract(epoch FROM f.trip_start::timestamp)::numeric, -1e30)
           WHEN 'expense_date_asc'  THEN  coalesce(extract(epoch FROM f.trip_start::timestamp)::numeric,  1e30)
           WHEN 'amount_desc'       THEN -coalesce(f.total_amount, -1e30)
           ELSE                           coalesce(f.total_amount,  1e30)
         END
  FROM filtered f;
$$;

REVOKE ALL ON FUNCTION public._debug_review_keyed_scope_v1(uuid,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_keyed_scope_v1(uuid,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_keyed_scope_v1(uuid,text,uuid,text,text[],text[],date,date,boolean,jsonb) TO authenticated;

COMMENT ON FUNCTION public._debug_review_keyed_scope_v1(uuid,text,uuid,text,text[],text[],date,date,boolean,jsonb) IS
  'THE filtered+ordered id/sort-key relation. Shared by the page and anchor RPCs so their filter and sort semantics cannot drift (DOC-080).';


-- 2 ── Queue page: corrected KPI semantics, shared keyed scope ----------------

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
  v_size   integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_sort   text    := coalesce(p_sort, 'created_desc');
  v_search text    := nullif(btrim(coalesce(p_general_search, '')), '');
  v_c_sk   numeric := NULL;
  v_c_id   uuid    := NULL;
  v_ctx    jsonb;
  v_out    jsonb;
BEGIN
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);
  v_ctx := public._debug_review_caller_context_v1(p_organization_id);

  IF v_sort NOT IN ('created_desc','created_asc','expense_date_desc',
                    'expense_date_asc','amount_desc','amount_asc') THEN
    RAISE EXCEPTION 'unsupported sort: %', v_sort USING ERRCODE = '22023';
  END IF;

  IF p_custom_filters IS NOT NULL AND jsonb_typeof(p_custom_filters) <> 'array' THEN
    RAISE EXCEPTION 'p_custom_filters must be a JSON array' USING ERRCODE = '22023';
  END IF;

  -- A cursor is only meaningful for the sort that produced it.
  IF p_cursor IS NOT NULL AND jsonb_typeof(p_cursor) = 'object'
     AND coalesce(p_cursor->>'sort', v_sort) = v_sort THEN
    BEGIN
      v_c_sk := nullif(p_cursor->>'sk','')::numeric;
      v_c_id := nullif(p_cursor->>'id','')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END;
    IF (v_c_sk IS NULL) <> (v_c_id IS NULL) THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END IF;
  ELSIF p_cursor IS NOT NULL AND jsonb_typeof(p_cursor) <> 'object' THEN
    RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
  END IF;

  WITH handoff AS (
    SELECT h.expense_id FROM public._debug_review_handoff_ids_v1(p_organization_id) h
  ),
  -- The COMPLETE reviewer-visible scope, unaffected by search and filters. This
  -- is the population the list pages through, so it is what the KPI cards
  -- describe.
  scope AS MATERIALIZED (
    SELECT e.id, e.user_id, e.status::text AS status, e.total_amount,
           e.assigned_reviewer_id, e.assigned_engineer_id,
           public._debug_review_actionability_v1(
             v_ctx->>'role', (v_ctx->>'caller_user_id')::uuid,
             e.status::text, e.approval_tier,
             e.assigned_reviewer_id, e.assigned_engineer_id,
             (v_ctx->>'hierarchy_enabled')::boolean,
             (v_ctx->>'team_leader_enabled')::boolean,
             (v_ctx->>'executive_enabled')::boolean,
             EXISTS (SELECT 1 FROM handoff h WHERE h.expense_id = e.id)
           ) AS act
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
    SELECT
      -- The card's existing meaning on this page: everything reachable through
      -- Review Expenses. Equal to scope_total by definition.
      count(*) AS assigned_to_me,
      count(*) AS scope_total,
      -- Preserved separately; NOT what the card shows.
      count(*) FILTER (WHERE s.assigned_reviewer_id = auth.uid()
                          OR s.assigned_engineer_id = auth.uid()) AS directly_assigned,
      count(*) FILTER (WHERE (s.act->>'is_actionable')::boolean) AS pending_review,
      count(*) FILTER (WHERE s.status IN ('verified','level_1_verified','level_2_verified')) AS verified,
      coalesce(sum(s.total_amount), 0) AS total_amount
    FROM scope s
  ),
  keyed AS MATERIALIZED (
    SELECT k.expense_id, k.sk
    FROM public._debug_review_keyed_scope_v1(
      p_organization_id, v_sort, p_employee_user_id, v_search,
      p_statuses, p_categories, p_date_from, p_date_to,
      coalesce(p_actionable_only, false), p_custom_filters) k
  ),
  tot AS (SELECT count(*) AS filtered_total FROM keyed),
  ordered AS MATERIALIZED (
    SELECT k.*, row_number() OVER (ORDER BY k.sk ASC, k.expense_id ASC) AS rn
    FROM keyed k
    WHERE v_c_id IS NULL OR (k.sk, k.expense_id) > (v_c_sk, v_c_id)
  ),
  -- page_size + 1 makes has_more exact.
  page_plus_one AS MATERIALIZED (
    SELECT o.* FROM ordered o WHERE o.rn <= v_size + 1
  ),
  page_ids AS MATERIALIZED (
    SELECT pp.* FROM page_plus_one pp WHERE pp.rn <= v_size
  ),
  -- Enrichment touches the page only, never the full scope.
  page_rows AS MATERIALIZED (
    SELECT e.id, e.user_id, e.status::text AS status, e.approval_tier, e.category,
           e.title, e.purpose, e.destination, e.total_amount, e.transaction_number,
           e.batch_id, e.created_at, e.trip_start,
           e.assigned_reviewer_id, e.assigned_engineer_id,
           pi.rn, pi.sk,
           public._debug_review_actionability_v1(
             v_ctx->>'role', (v_ctx->>'caller_user_id')::uuid,
             e.status::text, e.approval_tier,
             e.assigned_reviewer_id, e.assigned_engineer_id,
             (v_ctx->>'hierarchy_enabled')::boolean,
             (v_ctx->>'team_leader_enabled')::boolean,
             (v_ctx->>'executive_enabled')::boolean,
             EXISTS (SELECT 1 FROM handoff h WHERE h.expense_id = e.id)
           ) AS act
    FROM page_ids pi
    JOIN public.expenses e ON e.id = pi.expense_id
  ),
  page_identity AS MATERIALIZED (
    SELECT * FROM public._debug_review_resolve_identity_v1(
      p_organization_id, ARRAY(SELECT DISTINCT pr.user_id FROM page_rows pr))
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
  sel_ident AS (
    SELECT * FROM public._debug_review_resolve_identity_v1(
      p_organization_id,
      CASE WHEN p_employee_user_id IS NULL THEN ARRAY[]::uuid[]
           ELSE ARRAY[p_employee_user_id] END)
  ),
  sel_emp AS (
    SELECT jsonb_build_object(
      'user_id', p_employee_user_id,
      'employee_name', coalesce(si.employee_name, 'Unknown employee'),
      'employee_id', si.employee_id,
      'identity_source', coalesce(si.identity_source, 'unresolved'),
      'identity_issue', si.identity_issue,
      'visible_expense_count',
        (SELECT count(*) FROM scope s2 WHERE s2.user_id = p_employee_user_id),
      'actionable_expense_count',
        (SELECT count(*) FROM scope s2 WHERE s2.user_id = p_employee_user_id
           AND (s2.act->>'is_actionable')::boolean)
    ) AS j
    FROM sel_ident si
    WHERE p_employee_user_id IS NOT NULL
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
             'identity_issue', pi.identity_issue,
             'current_balance', coalesce(pi.current_balance, 0),
             'title', pr.title, 'purpose', pr.purpose, 'category', pr.category,
             'destination', pr.destination, 'total_amount', pr.total_amount,
             'status', pr.status, 'approval_tier', pr.approval_tier,
             'created_at', pr.created_at, 'trip_start', pr.trip_start,
             'is_resubmitted', EXISTS (SELECT 1 FROM public.audit_logs al
                WHERE al.expense_id = pr.id AND al.action = 'expense_resubmitted'),
             'was_reviewer_corrected', EXISTS (SELECT 1 FROM public.expense_correction_logs cl
                WHERE cl.expense_id = pr.id AND cl.organization_id = p_organization_id),
             'is_actionable',     (pr.act->>'is_actionable')::boolean,
             'actionable_stage',   pr.act->>'actionable_stage',
             'actionable_reason',  pr.act->>'actionable_reason',
             'available_actions',  pr.act->'available_actions',
             'view_only',         (pr.act->>'view_only')::boolean,
             'custom_fields', coalesce(pcf.fields, '[]'::jsonb)
           ) ORDER BY pr.rn) AS arr,
           count(*) AS n,
           count(*) FILTER (WHERE pi.identity_issue IS NULL) AS resolved,
           count(*) FILTER (WHERE pi.identity_issue IS NOT NULL) AS unresolved
    FROM page_rows pr
    LEFT JOIN page_identity pi ON pi.user_id = pr.user_id
    LEFT JOIN page_custom_fields pcf ON pcf.expense_id = pr.id
  ),
  last_row AS (
    SELECT pr.sk, pr.id FROM page_rows pr ORDER BY pr.rn DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'contract','debug-review-queue',
    'version',1,
    'request', jsonb_build_object(
      'employee_user_id', p_employee_user_id,
      'general_search', v_search,
      'sort', v_sort,
      'page_size', v_size,
      'actionable_only', coalesce(p_actionable_only, false)),
    'caller', jsonb_build_object(
      'role', v_ctx->>'role',
      'hierarchy_enabled', (v_ctx->>'hierarchy_enabled')::boolean,
      'team_leader_enabled', (v_ctx->>'team_leader_enabled')::boolean,
      'executive_enabled', (v_ctx->>'executive_enabled')::boolean),
    'selected_employee', (SELECT j FROM sel_emp),
    'scope_summary', (SELECT jsonb_build_object(
        'assigned_to_me', s.assigned_to_me,
        'scope_total', s.scope_total,
        'directly_assigned', s.directly_assigned,
        'pending_review', s.pending_review,
        'verified', s.verified,
        'total_amount', s.total_amount) FROM scope_summary s),
    'filtered_total', (SELECT filtered_total FROM tot),
    'total_pages', greatest(1, ceil((SELECT filtered_total FROM tot)::numeric / v_size)::integer),
    'has_more', (SELECT count(*) FROM page_plus_one) > v_size,
    'next_cursor', CASE WHEN (SELECT count(*) FROM page_plus_one) > v_size
      THEN (SELECT jsonb_build_object('sk', lr.sk::text, 'id', lr.id, 'sort', v_sort)
            FROM last_row lr)
      ELSE NULL END,
    'items', coalesce((SELECT arr FROM items), '[]'::jsonb),
    'diagnostics', jsonb_build_object(
      'page_returned', coalesce((SELECT n FROM items), 0),
      'identity_resolved', coalesce((SELECT resolved FROM items), 0),
      'identity_unresolved', coalesce((SELECT unresolved FROM items), 0),
      'schema_revision', '20260802010000')
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) TO authenticated;


-- 3 ── Page anchor: resolve a target page to the cursor before it -------------
-- The ONLY place a positional scan is allowed. Random access fundamentally
-- requires counting; the ordinary Next/Previous flow above stays pure keyset.

CREATE OR REPLACE FUNCTION public.get_debug_review_queue_page_anchor_v1(
  p_organization_id uuid,
  p_target_page integer,
  p_page_size integer DEFAULT 25,
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
  v_total   bigint;
  v_pages   integer;
  v_cursor  jsonb   := NULL;
BEGIN
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);

  IF v_sort NOT IN ('created_desc','created_asc','expense_date_desc',
                    'expense_date_asc','amount_desc','amount_asc') THEN
    RAISE EXCEPTION 'unsupported sort: %', v_sort USING ERRCODE = '22023';
  END IF;

  IF p_custom_filters IS NOT NULL AND jsonb_typeof(p_custom_filters) <> 'array' THEN
    RAISE EXCEPTION 'p_custom_filters must be a JSON array' USING ERRCODE = '22023';
  END IF;

  IF p_target_page IS NULL OR p_target_page < 1 THEN
    RAISE EXCEPTION 'target page must be 1 or greater' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_total
  FROM public._debug_review_keyed_scope_v1(
    p_organization_id, v_sort, p_employee_user_id, v_search,
    p_statuses, p_categories, p_date_from, p_date_to,
    coalesce(p_actionable_only, false), p_custom_filters);

  v_pages := greatest(1, ceil(v_total::numeric / v_size)::integer);

  IF p_target_page > v_pages THEN
    RAISE EXCEPTION 'target page % exceeds % page(s)', p_target_page, v_pages
      USING ERRCODE = '22023';
  END IF;

  -- Page 1 starts at the beginning, so it needs no cursor at all.
  IF p_target_page > 1 THEN
    SELECT jsonb_build_object('sk', a.sk::text, 'id', a.expense_id, 'sort', v_sort)
      INTO v_cursor
    FROM (
      SELECT k.expense_id, k.sk,
             row_number() OVER (ORDER BY k.sk ASC, k.expense_id ASC) AS rn
      FROM public._debug_review_keyed_scope_v1(
        p_organization_id, v_sort, p_employee_user_id, v_search,
        p_statuses, p_categories, p_date_from, p_date_to,
        coalesce(p_actionable_only, false), p_custom_filters) k
    ) a
    -- The last row of the previous page: the list RPC returns everything
    -- strictly after it, which is exactly the first row of the target page.
    WHERE a.rn = (p_target_page - 1)::bigint * v_size;
  END IF;

  RETURN jsonb_build_object(
    'contract', 'debug-review-page-anchor',
    'version', 1,
    'target_page', p_target_page,
    'page_size', v_size,
    'filtered_total', v_total,
    'total_pages', v_pages,
    'cursor', v_cursor
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_anchor_v1(uuid,integer,integer,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_anchor_v1(uuid,integer,integer,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_queue_page_anchor_v1(uuid,integer,integer,text,uuid,text,text[],text[],date,date,boolean,jsonb) TO authenticated;

COMMENT ON FUNCTION public.get_debug_review_queue_page_anchor_v1(uuid,integer,integer,text,uuid,text,text[],text[],date,date,boolean,jsonb) IS
  'Resolves a target page to the cursor immediately before it. The only positional scan; ordinary paging stays keyset (DOC-080).';


-- 4 ── Filter options: parent metadata, depth, is_root ------------------------
-- Branches form a TREE. Returning them flat is what made the client render one
-- dropdown per branch row (ten-plus identical "Project ID" controls).

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

  WITH RECURSIVE
  visible AS (
    SELECT e.id, e.category
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
  -- Branch definitions actually carrying data somewhere in the org. Obsolete
  -- branches would otherwise be offered as filters that can only return nothing.
  used_branches AS (
    SELECT DISTINCT fv.branch_field_id AS id
    FROM public.expense_form_field_values fv
    WHERE fv.organization_id = p_organization_id
      AND fv.branch_field_id IS NOT NULL
  ),
  branch_depth AS (
    -- Roots of the branch forest: children of a template, not of another branch.
    SELECT b.id, 1 AS depth, ARRAY[b.id] AS path
    FROM public.expense_form_field_option_branches b
    WHERE b.organization_id = p_organization_id
      AND b.parent_branch_id IS NULL
    UNION ALL
    SELECT c.id, bd.depth + 1, bd.path || c.id
    FROM branch_depth bd
    JOIN public.expense_form_field_option_branches c
      ON c.parent_branch_id = bd.id
     AND c.organization_id = p_organization_id
    -- Cycle-safe: bounded depth AND no revisiting a node already on the path.
    WHERE bd.depth < 10
      AND NOT c.id = ANY(bd.path)
  ),
  branch_depth_final AS (
    SELECT bd.id, min(bd.depth) AS depth FROM branch_depth bd GROUP BY bd.id
  ),
  fields AS (
    SELECT jsonb_build_object(
             'source', 'template',
             'field_id', t.id,
             'field_key', coalesce(t.field_key, t.id::text),
             'label', coalesce(t.name, t.field_key),
             'options', t.options,
             'parent_template_id', NULL,
             'parent_branch_id', NULL,
             'parent_option_value', NULL,
             'display_order', 0,
             'depth', 0,
             'is_root', true) AS d,
           0 AS ord, coalesce(t.name, t.field_key) AS nm
    FROM public.expense_form_field_templates t
    WHERE t.organization_id = p_organization_id
    UNION ALL
    SELECT jsonb_build_object(
             'source', 'branch',
             'field_id', b.id,
             'field_key', coalesce(b.field_key, b.id::text),
             'label', coalesce(b.name, b.field_key),
             'options', b.options,
             'parent_template_id', b.parent_template_id,
             'parent_branch_id', b.parent_branch_id,
             'parent_option_value', b.parent_option_value,
             'display_order', coalesce(b.display_order, 0),
             'depth', coalesce(bdf.depth, 1),
             'is_root', false) AS d,
           coalesce(b.display_order, 0) AS ord,
           coalesce(b.name, b.field_key) AS nm
    FROM public.expense_form_field_option_branches b
    LEFT JOIN branch_depth_final bdf ON bdf.id = b.id
    WHERE b.organization_id = p_organization_id
      AND b.retired_at IS NULL
      AND b.id IN (SELECT ub.id FROM used_branches ub)
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
    'employees', coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'user_id', p.user_id,
                     'employee_name', coalesce(nullif(btrim(p.name),''),'Unknown employee'),
                     'employee_id', p.employee_id))
                   FROM public.profiles p
                   WHERE p.organization_id = p_organization_id
                     AND p.user_id IN (SELECT DISTINCT e2.user_id FROM public.expenses e2
                                       WHERE e2.id IN (SELECT v.id FROM visible v))), '[]'::jsonb),
    'custom_fields', coalesce(
      (SELECT jsonb_agg(f.d ORDER BY f.ord, f.nm) FROM fields f), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_filter_options_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_filter_options_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_filter_options_v1(uuid) TO authenticated;


-- 5 ── Capability probe: require the anchor, report the new revision ----------

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
      to_regprocedure('public.get_debug_review_expense_detail_v1(uuid,uuid)') IS NOT NULL AS detail,
      to_regprocedure('public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean)') IS NOT NULL AS actionability,
      to_regprocedure('public._debug_review_resolve_identity_v1(uuid,uuid[])') IS NOT NULL AS identity,
      to_regprocedure('public.get_debug_review_queue_page_anchor_v1(uuid,integer,integer,text,uuid,text,text[],text[],date,date,boolean,jsonb)') IS NOT NULL AS page_anchor,
      to_regprocedure('public._debug_review_keyed_scope_v1(uuid,text,uuid,text,text[],text[],date,date,boolean,jsonb)') IS NOT NULL AS keyed_scope
  )
  SELECT jsonb_build_object(
    'contract', 'debug-review-queue',
    'version', 1,
    'ready', (f.employee_search AND f.page AND f.filters AND f.detail
              AND f.actionability AND f.identity AND f.page_anchor AND f.keyed_scope),
    'functions', jsonb_build_object(
      'employee_search', f.employee_search,
      'page', f.page,
      'filters', f.filters,
      'detail', f.detail,
      'actionability', f.actionability,
      'identity', f.identity,
      'page_anchor', f.page_anchor,
      'keyed_scope', f.keyed_scope
    ),
    'schema_revision', '20260802010000',
    'server_time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ) FROM f;
$$;

REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.debug_review_queue_capabilities_v1() TO authenticated;
