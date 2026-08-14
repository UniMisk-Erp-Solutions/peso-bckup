-- =============================================================================
-- Review Queue — filtered summary + authoritative batch state (DOC-080)
--
-- ADDITIVE and READ-ONLY. No INSERT/UPDATE/DELETE/TRUNCATE, no table DDL, no
-- storage access. Only CREATE OR REPLACE FUNCTION, COMMENT, REVOKE and GRANT.
-- 20260801140000, 20260801150000, 20260802010000 and 20260802020000 are applied
-- to the shared database and none of them is rewritten.
--
-- Two defects are fixed here, both of which need server authority:
--
-- 1) THE KPI CARDS DESCRIBED A DIFFERENT POPULATION FROM THE TABLE.
--    `scope_summary` is aggregated over the `scope` CTE — the whole assigned
--    scope, computed BEFORE any employee/status/category/date/custom predicate
--    is applied. So selecting employee 6174 left the cards reading 7,721 while
--    the table showed that employee's rows. The cards and the table were
--    answering two different questions on one screen.
--
--    `filtered_summary` is added alongside it, aggregated over the SAME rows the
--    table paginates — the filtered keyed scope, before the cursor predicate and
--    before the page-size limit. `scope_summary` is unchanged and remains the
--    unfiltered diagnostic.
--
--    The aggregation reuses the `scope` CTE's already-computed status class and
--    actionability rather than recomputing them, so the filtered summary costs
--    one semi-join, not a second actionability pass over 7,699 rows.
--
-- 2) EVERY "Review batch" BUTTON WAS BLUE.
--    The client could not colour it honestly: a page holds 25 rows, and a batch
--    whose remaining lines sit on page 4 would look finished from page 1.
--    Inferring whole-batch state from a page slice is exactly the mistake that
--    would tell a reviewer a batch was done when it was not.
--
--    Computed here instead, across EVERY line of each visible batch. The `scope`
--    CTE already holds one row per assigned expense with its actionability, so
--    the calculation is a single GROUP BY over rows already in memory — no
--    per-row request, no second pass, and no page-slice inference. Organization
--    isolation, canonical assignment scope, self-review exclusion and row
--    deduplication all come from `_debug_review_assigned_scope_v1` for free.
--
--    "Done" means NO REMAINING ACTION FOR THIS REVIEWER. It deliberately does
--    not require terminal status: a level_2_verified batch is finished work for
--    the executive who verified it, and must read grey for them, which is what
--    the legacy Review Expenses page did.
--
-- Filter semantics cannot drift: the filtered summary consumes the same
-- `_debug_review_keyed_scope_v1` relation the page rows and the page anchor
-- consume. There is still exactly one definition of "which rows".
--
-- All functions: SECURITY DEFINER, SET search_path = '', fully-qualified
-- relations, reviewer assertion, PUBLIC and anon revoked, authenticated granted.
-- =============================================================================


-- 1 ── Authoritative per-batch state ------------------------------------------
-- Standalone so it can be audited on its own, and so a future caller (mobile,
-- exports) cannot reimplement the thresholds slightly differently.
--
-- p_batch_ids is the set of batches visible on a page. Passing the visible set
-- rather than every batch in the organization keeps the work proportional to
-- what is on screen while still inspecting ALL lines of those batches.

CREATE OR REPLACE FUNCTION public._debug_review_batch_state_v1(
  p_organization_id uuid,
  p_batch_ids uuid[]
)
RETURNS TABLE(
  batch_id uuid,
  total_lines integer,
  actionable_lines integer,
  non_actionable_lines integer,
  action_state text
)
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
  -- The canonical assigned scope. Inherits organization isolation, the
  -- self-review exclusion and one-row-per-expense deduplication.
  lines AS (
    SELECT e.id, e.batch_id,
           public._debug_review_actionability_v1(
             (SELECT c.j->>'role' FROM ctx c),
             (SELECT (c.j->>'caller_user_id')::uuid FROM ctx c),
             e.status::text, e.approval_tier,
             e.assigned_reviewer_id, e.assigned_engineer_id,
             (SELECT (c.j->>'hierarchy_enabled')::boolean FROM ctx c),
             (SELECT (c.j->>'team_leader_enabled')::boolean FROM ctx c),
             (SELECT (c.j->>'executive_enabled')::boolean FROM ctx c),
             EXISTS (SELECT 1 FROM handoff h WHERE h.expense_id = e.id)
           ) AS act
    FROM public._debug_review_assigned_scope_v1(p_organization_id) a
    JOIN public.expenses e ON e.id = a.expense_id
    WHERE e.batch_id IS NOT NULL
      AND e.batch_id = ANY(coalesce(p_batch_ids, ARRAY[]::uuid[]))
  ),
  agg AS (
    SELECT l.batch_id,
           count(*)::integer AS total_lines,
           count(*) FILTER (WHERE (l.act->>'is_actionable')::boolean)::integer AS actionable_lines
    FROM lines l
    GROUP BY l.batch_id
  )
  SELECT g.batch_id,
         g.total_lines,
         g.actionable_lines,
         (g.total_lines - g.actionable_lines)::integer,
         CASE
           -- No remaining action for THIS reviewer. Not the same as terminal.
           WHEN g.actionable_lines = 0                 THEN 'all_done'
           WHEN g.actionable_lines = g.total_lines     THEN 'all_pending'
           ELSE                                             'partial'
         END
  FROM agg g;
$$;

REVOKE ALL ON FUNCTION public._debug_review_batch_state_v1(uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_batch_state_v1(uuid,uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_batch_state_v1(uuid,uuid[]) TO authenticated;

COMMENT ON FUNCTION public._debug_review_batch_state_v1(uuid,uuid[]) IS
  'Whole-batch state across EVERY assigned line of the given batches. all_done means no remaining action for the caller, not terminal status (DOC-080).';


-- 2 ── Queue page: adds filtered_summary and batch_state ----------------------
-- Paging, filtering, identity, custom fields and actionability are byte-for-byte
-- the 20260802020000 definitions. Only the two new response blocks are added.

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
  assigned AS MATERIALIZED (
    SELECT a.expense_id, a.assignment_reasons
    FROM public._debug_review_assigned_scope_v1(p_organization_id) a
  ),
  scope AS MATERIALIZED (
    -- batch_id is carried so whole-batch state needs no extra scan.
    SELECT e.id, e.user_id, e.status::text AS status, e.total_amount, e.batch_id,
           e.assigned_reviewer_id, e.assigned_engineer_id,
           a.assignment_reasons,
           public._debug_review_status_class_v1(e.status::text) AS class,
           public._debug_review_actionability_v1(
             v_ctx->>'role', (v_ctx->>'caller_user_id')::uuid,
             e.status::text, e.approval_tier,
             e.assigned_reviewer_id, e.assigned_engineer_id,
             (v_ctx->>'hierarchy_enabled')::boolean,
             (v_ctx->>'team_leader_enabled')::boolean,
             (v_ctx->>'executive_enabled')::boolean,
             EXISTS (SELECT 1 FROM handoff h WHERE h.expense_id = e.id)
           ) AS act
    FROM assigned a
    JOIN public.expenses e ON e.id = a.expense_id
  ),
  summary AS (
    SELECT
      count(*) AS assigned_to_me,
      count(*) AS scope_total,
      count(*) FILTER (WHERE s.class = 'pending')      AS pending_review,
      count(*) FILTER (WHERE s.class = 'terminal')     AS completed_review,
      count(*) FILTER (WHERE s.class = 'unclassified') AS unclassified,
      count(*) FILTER (WHERE s.status IN ('verified','level_1_verified','level_2_verified')
                         AND s.class = 'terminal')     AS verified,
      count(*) FILTER (WHERE s.status = 'approved')    AS approved,
      count(*) FILTER (WHERE s.status = 'rejected')    AS rejected,
      count(*) FILTER (WHERE s.status = 'paid')        AS paid,
      count(*) FILTER (WHERE s.class = 'terminal'
                         AND s.status NOT IN ('verified','approved','rejected','paid'))
                                                       AS other_terminal,
      count(*) FILTER (WHERE (s.act->>'is_actionable')::boolean) AS actionable_now,
      count(*) FILTER (WHERE s.class = 'pending'
                         AND NOT (s.act->>'is_actionable')::boolean)
                                                       AS active_not_actionable_now,
      count(*) FILTER (WHERE 'direct_reviewer_assignment' = ANY(s.assignment_reasons)
                          OR 'direct_engineer_assignment' = ANY(s.assignment_reasons))
                                                       AS directly_assigned,
      count(*) FILTER (WHERE 'reporting_hierarchy_assignment' = ANY(s.assignment_reasons))
                                                       AS hierarchy_assigned,
      count(*) FILTER (WHERE 'team_manager_assignment'   = ANY(s.assignment_reasons)
                          OR 'team_leader_assignment'    = ANY(s.assignment_reasons)
                          OR 'executive_team_assignment' = ANY(s.assignment_reasons))
                                                       AS team_assigned,
      count(*) FILTER (WHERE 'organization_admin_scope' = ANY(s.assignment_reasons))
                                                       AS admin_scope_assigned,
      count(*) FILTER (WHERE s.user_id = auth.uid())   AS self_owned_visible_expenses,
      coalesce(sum(s.total_amount), 0)                 AS total_amount
    FROM scope s
  ),
  leak AS (
    SELECT count(*) AS visible_without_assignment_reason
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status::text <> 'draft'
      AND (
           e.user_id IN (SELECT v.user_id
                         FROM public._debug_review_visible_user_ids_v1(p_organization_id) v)
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid()
      )
      AND e.user_id <> auth.uid()
      AND NOT EXISTS (SELECT 1 FROM assigned a WHERE a.expense_id = e.id)
  ),
  keyed AS MATERIALIZED (
    SELECT k.expense_id, k.sk
    FROM public._debug_review_keyed_scope_v1(
      p_organization_id, v_sort, p_employee_user_id, v_search,
      p_statuses, p_categories, p_date_from, p_date_to,
      coalesce(p_actionable_only, false), p_custom_filters) k
    WHERE k.expense_id IN (SELECT a.expense_id FROM assigned a)
  ),
  tot AS (SELECT count(*) AS filtered_total FROM keyed),
  -- THE filtered summary. Same rows the table paginates, aggregated BEFORE the
  -- cursor predicate and BEFORE the page-size limit, so paging cannot move it.
  -- Reuses `scope`'s class and actionability instead of recomputing them.
  filtered AS MATERIALIZED (
    SELECT s.* FROM scope s WHERE s.id IN (SELECT k.expense_id FROM keyed k)
  ),
  fsummary AS (
    SELECT
      count(*) AS assigned_to_me,
      count(*) FILTER (WHERE f.class = 'pending')      AS pending_review,
      count(*) FILTER (WHERE f.class = 'terminal')     AS completed_review,
      count(*) FILTER (WHERE f.class = 'unclassified') AS unclassified,
      count(*) FILTER (WHERE f.status IN ('verified','level_1_verified','level_2_verified')
                         AND f.class = 'terminal')     AS verified,
      count(*) FILTER (WHERE f.status = 'approved')    AS approved,
      count(*) FILTER (WHERE f.status = 'rejected')    AS rejected,
      count(*) FILTER (WHERE f.status = 'paid')        AS paid,
      count(*) FILTER (WHERE f.class = 'terminal'
                         AND f.status NOT IN ('verified','approved','rejected','paid'))
                                                       AS other_terminal,
      count(*) FILTER (WHERE (f.act->>'is_actionable')::boolean) AS actionable_now,
      count(*) FILTER (WHERE f.class = 'pending'
                         AND NOT (f.act->>'is_actionable')::boolean)
                                                       AS active_not_actionable_now,
      coalesce(sum(f.total_amount), 0)                 AS total_amount
    FROM filtered f
  ),
  ordered AS MATERIALIZED (
    SELECT k.*, row_number() OVER (ORDER BY k.sk ASC, k.expense_id ASC) AS rn
    FROM keyed k
    WHERE v_c_id IS NULL OR (k.sk, k.expense_id) > (v_c_sk, v_c_id)
  ),
  page_plus_one AS MATERIALIZED (
    SELECT o.* FROM ordered o WHERE o.rn <= v_size + 1
  ),
  page_ids AS MATERIALIZED (
    SELECT pp.* FROM page_plus_one pp WHERE pp.rn <= v_size
  ),
  page_rows AS MATERIALIZED (
    SELECT e.id, e.user_id, e.status::text AS status, e.approval_tier, e.category,
           e.title, e.purpose, e.destination, e.total_amount, e.transaction_number,
           e.batch_id, e.created_at, e.trip_start,
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
  -- Whole-batch state for every batch on this page, over EVERY assigned line of
  -- those batches — not the page slice. One GROUP BY, no per-row request.
  batch_state AS (
    SELECT s.batch_id,
           count(*)::integer AS total_lines,
           count(*) FILTER (WHERE (s.act->>'is_actionable')::boolean)::integer
             AS actionable_lines
    FROM scope s
    WHERE s.batch_id IS NOT NULL
      AND s.batch_id IN (SELECT DISTINCT pr.batch_id
                         FROM page_rows pr WHERE pr.batch_id IS NOT NULL)
    GROUP BY s.batch_id
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
             -- Whole-batch state, denormalized onto the row so the table needs
             -- no lookup and desktop/mobile cannot disagree.
             'batch_total_lines',        bs.total_lines,
             'batch_actionable_lines',   bs.actionable_lines,
             'batch_non_actionable_lines',
               CASE WHEN bs.total_lines IS NULL THEN NULL
                    ELSE bs.total_lines - bs.actionable_lines END,
             'batch_action_state',
               CASE
                 WHEN pr.batch_id IS NULL OR bs.total_lines IS NULL THEN NULL
                 WHEN bs.actionable_lines = 0                  THEN 'all_done'
                 WHEN bs.actionable_lines = bs.total_lines     THEN 'all_pending'
                 ELSE                                               'partial'
               END,
             'custom_fields', coalesce(pcf.fields, '[]'::jsonb)
           ) ORDER BY pr.rn) AS arr,
           count(*) AS n,
           count(*) FILTER (WHERE pi.identity_issue IS NULL) AS resolved,
           count(*) FILTER (WHERE pi.identity_issue IS NOT NULL) AS unresolved
    FROM page_rows pr
    LEFT JOIN page_identity pi ON pi.user_id = pr.user_id
    LEFT JOIN page_custom_fields pcf ON pcf.expense_id = pr.id
    LEFT JOIN batch_state bs ON bs.batch_id = pr.batch_id
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
        'pending_review', s.pending_review,
        'completed_review', s.completed_review,
        'verified', s.verified,
        'approved', s.approved,
        'rejected', s.rejected,
        'paid', s.paid,
        'other_terminal', s.other_terminal,
        'actionable_now', s.actionable_now,
        'active_not_actionable_now', s.active_not_actionable_now,
        'directly_assigned', s.directly_assigned,
        'hierarchy_assigned', s.hierarchy_assigned,
        'team_assigned', s.team_assigned,
        'admin_scope_assigned', s.admin_scope_assigned,
        'unclassified', s.unclassified,
        'self_owned_visible_expenses', s.self_owned_visible_expenses,
        'visible_without_assignment_reason', (SELECT l.visible_without_assignment_reason FROM leak l),
        'total_amount', s.total_amount,
        'reconciliation_ok',
          (s.assigned_to_me = s.pending_review + s.completed_review + s.unclassified)
          AND (s.completed_review = s.verified + s.approved + s.rejected
                                  + s.paid + s.other_terminal)
          AND (s.pending_review = s.actionable_now + s.active_not_actionable_now)
          AND s.unclassified = 0
          AND s.self_owned_visible_expenses = 0
          AND (SELECT l.visible_without_assignment_reason FROM leak l) = 0
      ) FROM summary s),
    -- The same reconciled shape over the FILTERED population. assigned_to_me is
    -- filtered_total by construction: both count the same relation.
    'filtered_summary', (SELECT jsonb_build_object(
        'assigned_to_me', fs.assigned_to_me,
        'pending_review', fs.pending_review,
        'completed_review', fs.completed_review,
        'verified', fs.verified,
        'approved', fs.approved,
        'rejected', fs.rejected,
        'paid', fs.paid,
        'other_terminal', fs.other_terminal,
        'actionable_now', fs.actionable_now,
        'active_not_actionable_now', fs.active_not_actionable_now,
        'unclassified', fs.unclassified,
        'total_amount', fs.total_amount,
        'reconciliation_ok',
          (fs.assigned_to_me = fs.pending_review + fs.completed_review + fs.unclassified)
          AND (fs.completed_review = fs.verified + fs.approved + fs.rejected
                                   + fs.paid + fs.other_terminal)
          AND (fs.pending_review = fs.actionable_now + fs.active_not_actionable_now)
          AND fs.unclassified = 0
          AND fs.assigned_to_me = (SELECT t.filtered_total FROM tot t)
      ) FROM fsummary fs),
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
      'batches_on_page', coalesce((SELECT count(*) FROM batch_state), 0),
      'schema_revision', '20260802030000')
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) TO authenticated;

COMMENT ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) IS
  'Review queue page. scope_summary = whole assigned scope (diagnostic). filtered_summary = the rows the table paginates. batch_action_state = whole-batch state across every assigned line (DOC-080).';


-- 3 ── Capability probe: new revision, advertises the new contract ------------

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
      to_regprocedure('public._debug_review_keyed_scope_v1(uuid,text,uuid,text,text[],text[],date,date,boolean,jsonb)') IS NOT NULL AS keyed_scope,
      to_regprocedure('public._debug_review_assigned_scope_v1(uuid)') IS NOT NULL AS assigned_scope,
      to_regprocedure('public.get_debug_review_scope_audit_v1(uuid)') IS NOT NULL AS scope_audit,
      to_regprocedure('public._debug_review_batch_state_v1(uuid,uuid[])') IS NOT NULL AS batch_state
  )
  SELECT jsonb_build_object(
    'contract', 'debug-review-queue',
    'version', 1,
    'ready', (f.employee_search AND f.page AND f.filters AND f.detail
              AND f.actionability AND f.identity AND f.page_anchor AND f.keyed_scope
              AND f.assigned_scope AND f.scope_audit AND f.batch_state),
    'functions', jsonb_build_object(
      'employee_search', f.employee_search,
      'page', f.page,
      'filters', f.filters,
      'detail', f.detail,
      'actionability', f.actionability,
      'identity', f.identity,
      'page_anchor', f.page_anchor,
      'keyed_scope', f.keyed_scope,
      'assigned_scope', f.assigned_scope,
      'scope_audit', f.scope_audit,
      'batch_state', f.batch_state
    ),
    -- Response blocks the client may rely on. A client that needs
    -- filtered_summary must refuse to render KPIs rather than show 0 when an
    -- older server omits it.
    'response_features', jsonb_build_array('filtered_summary','batch_state'),
    'schema_revision', '20260802030000',
    'server_time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ) FROM f;
$$;

REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.debug_review_queue_capabilities_v1() TO authenticated;
