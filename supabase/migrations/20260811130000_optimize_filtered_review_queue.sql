-- DOC-080 rev 22 — optimize get_debug_review_queue_page_v1 for filtered requests.
--
-- Production incident: a filtered Review search (e.g. employee 6174) for a large
-- reviewer scope took ~24s COLD because the RPC reconciled the ENTIRE reviewer
-- scope (~9,342 rows) via a per-row plpgsql actionability call on EVERY page —
-- measured at ~47s for the full-scope actionability alone. The `authenticated`
-- role's 8s statement_timeout then killed the cold query (SQLSTATE 57014), so the
-- browser filtered search failed and the table never updated.
--
-- This migration replaces the function so that when a filter is active
-- (employee / general search / status / category / date / custom / actionable),
-- per-row actionability is computed ONLY over the FILTERED population and the
-- page's batch siblings — never the full scope. scope_summary (which the UI only
-- reads when UNfiltered — see summarySource.chooseSummary) is returned as a cheap
-- status-class rollup for filtered queries. The UNFILTERED path is byte-identical
-- to the previous definition.
--
-- Read-only function (STABLE, no data mutation). Signature, return contract,
-- SECURITY DEFINER, `SET search_path TO ''` and grants are all preserved.
-- Validated live against the previous definition: unfiltered output byte-identical;
-- filtered items / ordering / filtered_summary / filtered_total / pagination /
-- cursor all identical. Rollback: re-apply the previous definition
-- (sha256 978b6ada38cacd075dc6adca186760b4058642438f4e030e579dfaee8c23b4cf).

-- Optimized get_debug_review_queue_page_v1: filtered queries no longer reconcile
-- the entire reviewer scope. Unfiltered path is byte-identical to the current
-- function; filtered path computes per-row actionability ONLY over the filtered
-- population + the page's batch siblings, and returns a cheap (never-displayed)
-- scope_summary. Read-only. Signature/contract/security preserved.
CREATE OR REPLACE FUNCTION public.get_debug_review_queue_page_v1(
  p_organization_id uuid, p_page_size integer DEFAULT 25, p_cursor jsonb DEFAULT NULL::jsonb,
  p_sort text DEFAULT 'created_desc'::text, p_employee_user_id uuid DEFAULT NULL::uuid,
  p_general_search text DEFAULT NULL::text, p_statuses text[] DEFAULT NULL::text[],
  p_categories text[] DEFAULT NULL::text[], p_date_from date DEFAULT NULL::date,
  p_date_to date DEFAULT NULL::date, p_actionable_only boolean DEFAULT false,
  p_custom_filters jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $fn$
DECLARE
  v_size   integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_sort   text    := coalesce(p_sort, 'created_desc');
  v_search text    := nullif(btrim(coalesce(p_general_search, '')), '');
  v_c_sk   numeric := NULL;
  v_c_id   uuid    := NULL;
  v_ctx    jsonb;
  v_out    jsonb;
  v_filtered boolean;
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

  v_filtered := (p_employee_user_id IS NOT NULL)
    OR (v_search IS NOT NULL)
    OR (p_statuses   IS NOT NULL AND array_length(p_statuses,1)   > 0)
    OR (p_categories IS NOT NULL AND array_length(p_categories,1) > 0)
    OR (p_date_from IS NOT NULL)
    OR (p_date_to   IS NOT NULL)
    OR coalesce(p_actionable_only, false)
    OR (p_custom_filters IS NOT NULL AND jsonb_typeof(p_custom_filters)='array'
        AND jsonb_array_length(p_custom_filters) > 0);

  IF NOT v_filtered THEN
    -- ================= UNFILTERED PATH (verbatim, unchanged) =================
    WITH handoff AS (
      SELECT h.expense_id FROM public._debug_review_handoff_ids_v1(p_organization_id) h
    ),
    assigned AS MATERIALIZED (
      SELECT a.expense_id, a.assignment_reasons
      FROM public._debug_review_assigned_scope_v1(p_organization_id) a
    ),
    scope AS MATERIALIZED (
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

  ELSE
    -- ================= FILTERED PATH (optimized) =================
    -- Actionability is computed ONLY over the filtered population + the page's
    -- batch siblings. scope_summary is a cheap status-class rollup (never shown
    -- for a filtered query — summarySource selects filtered_summary), so the
    -- reviewer-wide per-row actionability is skipped (§12).
    WITH handoff AS (
      SELECT h.expense_id FROM public._debug_review_handoff_ids_v1(p_organization_id) h
    ),
    assigned AS MATERIALIZED (
      SELECT a.expense_id, a.assignment_reasons
      FROM public._debug_review_assigned_scope_v1(p_organization_id) a
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
    filtered AS MATERIALIZED (
      SELECT e.id, e.user_id, e.status::text AS status, e.total_amount, e.batch_id,
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
      FROM keyed k JOIN public.expenses e ON e.id = k.expense_id
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
    scope_light AS MATERIALIZED (
      SELECT e.id, e.user_id, e.status::text AS status, e.total_amount,
             a.assignment_reasons,
             public._debug_review_status_class_v1(e.status::text) AS class
      FROM assigned a JOIN public.expenses e ON e.id = a.expense_id
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
      FROM scope_light s
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
    page_batches AS (
      SELECT DISTINCT pr.batch_id FROM page_rows pr WHERE pr.batch_id IS NOT NULL
    ),
    batch_scope AS MATERIALIZED (
      SELECT e.batch_id,
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
      WHERE e.batch_id IN (SELECT batch_id FROM page_batches)
    ),
    batch_state AS (
      SELECT bs.batch_id,
             count(*)::integer AS total_lines,
             count(*) FILTER (WHERE (bs.act->>'is_actionable')::boolean)::integer
               AS actionable_lines
      FROM batch_scope bs
      GROUP BY bs.batch_id
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
          (SELECT count(*) FROM scope_light s2 WHERE s2.user_id = p_employee_user_id),
        'actionable_expense_count',
          (SELECT count(*) FROM filtered f2 WHERE f2.user_id = p_employee_user_id
             AND (f2.act->>'is_actionable')::boolean)
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
          'actionable_now', 0,
          'active_not_actionable_now', s.pending_review,
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
            AND s.unclassified = 0
            AND s.self_owned_visible_expenses = 0
            AND (SELECT l.visible_without_assignment_reason FROM leak l) = 0
        ) FROM summary s),
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
  END IF;

  RETURN v_out;
END;
$fn$;

-- Preserve the authenticated EXECUTE grant explicitly (CREATE OR REPLACE keeps
-- existing grants; this makes a fresh replay self-contained).
GRANT EXECUTE ON FUNCTION public.get_debug_review_queue_page_v1(
  uuid, integer, jsonb, text, uuid, text, text[], text[], date, date, boolean, jsonb
) TO authenticated;
