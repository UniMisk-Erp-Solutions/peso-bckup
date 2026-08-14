-- =============================================================================
-- Review Queue — canonical assignment scope + reconcilable KPIs (DOC-080)
--
-- ADDITIVE. 20260801140000, 20260801150000 and 20260802010000 are applied to the
-- shared database, so none of them is rewritten.
--
-- Why this exists: the page showed
--
--     Assigned to Me 7,564   Pending Review 5,260   Verified 558
--
-- leaving 1,746 rows in no card at all. A read-only audit of Production on
-- 2026-08-02 (reviewer Kunvar Thakor, executive) gave the exact composition:
--
--     submitted   @ team_leader  not actionable   1,775
--     approved                   terminal             3
--     rejected                   terminal             3
--     submitted   @ engineer     not actionable       1
--                                                 ------
--     neither actionable nor "verified"            1,782
--     less level_1_verified counted in BOTH cards    -36
--                                                 ------
--                                                  1,746
--
-- So the gap was NOT mostly approved/rejected rows — there are only six of those
-- in the whole organization. Three distinct defects produced it:
--
--   a) "Pending Review" was the ACTIONABLE-NOW count. 1,775 submitted expenses
--      sitting at the team_leader tier are legitimately assigned to this
--      executive through the reporting hierarchy, but he cannot act on them yet,
--      so they belonged to no card.
--
--   b) The two cards OVERLAPPED. level_1_verified is simultaneously actionable
--      (counted in Pending) and matched the old verified-family filter (counted
--      in Verified), double-counting 36 rows and shrinking the visible gap.
--
--   c) approved and rejected had no card at all.
--
-- A fourth finding changes the card's meaning: level_1_verified and
-- level_2_verified are MID-workflow, not terminal. The old "Verified 558" was
-- 520 level_2 + 36 level_1 + 2 truly verified. Under an honest terminal
-- definition the completed count for this reviewer is 8, not 558 — a large,
-- deliberate, and correct drop.
--
-- It also introduces ONE canonical assigned-scope helper carrying the REASON a
-- row is visible, so "assigned" can be audited row by row instead of trusted.
--
-- SELF-REVIEW. The audit found exactly one visible row with no assignment
-- reason: transaction 03994, an expense owned by the reviewer himself. The
-- deployed visibility helper includes the caller at depth 0 of the reporting
-- walk, so a reviewer saw their own expense in their own queue. The scope
-- helper now excludes e.user_id = auth.uid() outright, and the summary carries
-- self_owned_visible_expenses so a regression shows up as a number.
--
-- Every table-reading function is SECURITY DEFINER with SET search_path = ''
-- and fully-qualified relations. _debug_review_status_class_v1 is a pure
-- IMMUTABLE function over a text argument, so it needs neither. All five are
-- revoked from PUBLIC and anon and granted to authenticated only.
-- No table DDL, no data changes, no storage access.
-- =============================================================================


-- 1 ── Canonical assigned scope, with the reason each row is visible ----------
-- One row per expense even when several reasons apply; reasons are aggregated
-- into an array rather than duplicating the expense.

CREATE OR REPLACE FUNCTION public._debug_review_assigned_scope_v1(
  p_organization_id uuid
)
RETURNS TABLE(expense_id uuid, assignment_reasons text[])
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
  -- Employees reporting to the caller, directly or transitively.
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
    -- depth 0 is the caller; their own expenses are not "assigned to review".
    SELECT DISTINCT walk.user_id FROM walk WHERE walk.depth > 0
  ),
  team_manager AS (
    SELECT tm.user_id
    FROM public.teams t
    JOIN public.team_members tm ON tm.team_id = t.id
                               AND tm.organization_id = p_organization_id
    JOIN caller c ON t.manager_user_id = c.user_id AND c.role = 'engineer'
    WHERE t.organization_id = p_organization_id
  ),
  team_leader AS (
    SELECT tm.user_id
    FROM public.teams t
    JOIN public.team_members tm ON tm.team_id = t.id
                               AND tm.organization_id = p_organization_id
    JOIN caller c ON t.team_leader_user_id = c.user_id AND c.role = 'team_leader'
    WHERE t.organization_id = p_organization_id
  ),
  team_executive AS (
    SELECT tm.user_id
    FROM public.teams t
    JOIN public.team_members tm ON tm.team_id = t.id
                               AND tm.organization_id = p_organization_id
    JOIN caller c ON t.executive_user_id = c.user_id AND c.role = 'executive'
    WHERE t.organization_id = p_organization_id
  ),
  -- Org admins review the whole organization by role, not by assignment. Kept
  -- as its own explicit reason so it can never be mistaken for a leak.
  admin_scope AS (
    SELECT p.user_id
    FROM public.profiles p, caller c
    WHERE c.role = 'admin' AND p.organization_id = p_organization_id
  ),
  candidates AS (
    SELECT e.id, e.user_id, e.assigned_reviewer_id, e.assigned_engineer_id
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status::text <> 'draft'
      -- A reviewer never reviews their own expense. The deployed visibility
      -- helper includes the caller at depth 0 of the reporting walk, which is
      -- how transaction 03994 (owned by the executive himself) reached his own
      -- queue. Excluded here explicitly rather than relying on the tree shape.
      AND e.user_id <> auth.uid()
      AND EXISTS (SELECT 1 FROM caller)
  ),
  reasoned AS (
    SELECT c.id, r.reason
    FROM candidates c
    CROSS JOIN LATERAL (
      SELECT 'direct_reviewer_assignment'::text AS reason
        WHERE c.assigned_reviewer_id = auth.uid()
      UNION ALL
      SELECT 'direct_engineer_assignment'
        WHERE c.assigned_engineer_id = auth.uid()
      UNION ALL
      SELECT 'reporting_hierarchy_assignment'
        WHERE c.user_id IN (SELECT t.user_id FROM tree t)
      UNION ALL
      SELECT 'team_manager_assignment'
        WHERE c.user_id IN (SELECT tm.user_id FROM team_manager tm)
      UNION ALL
      SELECT 'team_leader_assignment'
        WHERE c.user_id IN (SELECT tl.user_id FROM team_leader tl)
      UNION ALL
      SELECT 'executive_team_assignment'
        WHERE c.user_id IN (SELECT te.user_id FROM team_executive te)
      UNION ALL
      SELECT 'organization_admin_scope'
        WHERE c.user_id IN (SELECT a.user_id FROM admin_scope a)
    ) r
  )
  SELECT rs.id, array_agg(DISTINCT rs.reason ORDER BY rs.reason)
  FROM reasoned rs
  GROUP BY rs.id;
$$;

REVOKE ALL ON FUNCTION public._debug_review_assigned_scope_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_assigned_scope_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_assigned_scope_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public._debug_review_assigned_scope_v1(uuid) IS
  'THE assigned scope. One row per expense with every reason it is visible. A row with no reason is never returned (DOC-080).';


-- 2 ── Status classification, explicit and exhaustive -------------------------
-- Returns 'pending' | 'terminal' | 'unclassified'. An unfamiliar status is NOT
-- silently bucketed; it becomes unclassified so reconciliation fails loudly.

CREATE OR REPLACE FUNCTION public._debug_review_status_class_v1(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_status IN ('submitted','edited','under_review',
                      'level_1_verified','level_2_verified') THEN 'pending'
    WHEN p_status IN ('verified','approved','rejected','paid') THEN 'terminal'
    ELSE 'unclassified'
  END;
$$;

REVOKE ALL ON FUNCTION public._debug_review_status_class_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_status_class_v1(text) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_status_class_v1(text) TO authenticated;


-- 3 ── Audit view of the scope: reasons + statuses, for diagnosis -------------
-- Read-only reporting surface. The ordinary UI never shows this.

CREATE OR REPLACE FUNCTION public.get_debug_review_scope_audit_v1(
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

  WITH scope AS (
    SELECT s.expense_id, s.assignment_reasons
    FROM public._debug_review_assigned_scope_v1(p_organization_id) s
  ),
  rows AS (
    SELECT sc.expense_id, sc.assignment_reasons,
           e.status::text AS status,
           public._debug_review_status_class_v1(e.status::text) AS class
    FROM scope sc
    JOIN public.expenses e ON e.id = sc.expense_id
  ),
  by_reason AS (
    SELECT r.reason, count(DISTINCT rw.expense_id) AS n
    FROM rows rw, unnest(rw.assignment_reasons) AS r(reason)
    GROUP BY r.reason
  ),
  by_status AS (
    SELECT rw.status, rw.class, count(*) AS n
    FROM rows rw GROUP BY rw.status, rw.class
  )
  SELECT jsonb_build_object(
    'contract','debug-review-scope-audit',
    'version',1,
    'assigned_total', (SELECT count(*) FROM rows),
    'multi_reason_total', (SELECT count(*) FROM rows WHERE array_length(assignment_reasons,1) > 1),
    'by_assignment_reason', coalesce((
      SELECT jsonb_object_agg(b.reason, b.n) FROM by_reason b), '{}'::jsonb),
    'by_status', coalesce((
      SELECT jsonb_agg(jsonb_build_object('status', s.status, 'class', s.class, 'count', s.n)
             ORDER BY s.class, s.status) FROM by_status s), '[]'::jsonb),
    'unclassified_statuses', coalesce((
      SELECT jsonb_agg(DISTINCT s.status) FROM by_status s WHERE s.class = 'unclassified'),
      '[]'::jsonb),
    -- Rows the old visibility helper returned that the reason-based scope does
    -- not: a nonzero value here is a visibility defect, not a rounding error.
    'visible_without_assignment_reason', (
      SELECT count(*) FROM public.expenses e
      WHERE e.organization_id = p_organization_id
        AND e.status::text <> 'draft'
        AND (
             e.user_id IN (SELECT v.user_id
                           FROM public._debug_review_visible_user_ids_v1(p_organization_id) v)
          OR e.assigned_engineer_id = auth.uid()
          OR e.assigned_reviewer_id = auth.uid()
        )
        AND e.user_id <> auth.uid()
        AND NOT EXISTS (SELECT 1 FROM scope sc WHERE sc.expense_id = e.id)
    ),
    'schema_revision', '20260802020000'
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_scope_audit_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_scope_audit_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_scope_audit_v1(uuid) TO authenticated;


-- 4 ── Queue page: exhaustive, reconcilable scope_summary ---------------------
-- Only the scope_summary block changes; paging, filtering, identity and
-- actionability are untouched from 20260802010000.

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
    SELECT e.id, e.user_id, e.status::text AS status, e.total_amount,
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
      -- Must be 0: the scope helper excludes them, so a nonzero value means the
      -- exclusion regressed.
      count(*) FILTER (WHERE s.user_id = auth.uid())   AS self_owned_visible_expenses,
      coalesce(sum(s.total_amount), 0)                 AS total_amount
    FROM scope s
  ),
  -- Rows the OLD visibility predicate would have shown that carry no assignment
  -- reason. Surfaced so a leak is a number on the response, not a silent bug.
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
    -- The filtered list can never exceed the assigned scope.
    WHERE k.expense_id IN (SELECT a.expense_id FROM assigned a)
  ),
  tot AS (SELECT count(*) AS filtered_total FROM keyed),
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
        -- True only when every invariant holds simultaneously.
        'reconciliation_ok',
          (s.assigned_to_me = s.pending_review + s.completed_review + s.unclassified)
          AND (s.completed_review = s.verified + s.approved + s.rejected
                                  + s.paid + s.other_terminal)
          AND (s.pending_review = s.actionable_now + s.active_not_actionable_now)
          AND s.unclassified = 0
          AND s.self_owned_visible_expenses = 0
          AND (SELECT l.visible_without_assignment_reason FROM leak l) = 0
      ) FROM summary s),
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
      'schema_revision', '20260802020000')
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) TO authenticated;


-- 5 ── Capability probe: require the new helpers, report the new revision -----

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
      to_regprocedure('public.get_debug_review_scope_audit_v1(uuid)') IS NOT NULL AS scope_audit
  )
  SELECT jsonb_build_object(
    'contract', 'debug-review-queue',
    'version', 1,
    'ready', (f.employee_search AND f.page AND f.filters AND f.detail
              AND f.actionability AND f.identity AND f.page_anchor AND f.keyed_scope
              AND f.assigned_scope AND f.scope_audit),
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
      'scope_audit', f.scope_audit
    ),
    'schema_revision', '20260802020000',
    'server_time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ) FROM f;
$$;

REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.debug_review_queue_capabilities_v1() TO authenticated;
