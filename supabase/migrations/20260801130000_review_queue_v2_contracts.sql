-- =============================================================================
-- DOC-079 — Review Expenses V2 contracts
--
-- NOT EXECUTED by the change that shipped this file. Apply manually.
--
-- Design rules encoded here:
--   * one JSONB value per RPC (no row sets) -> immune to the PostgREST 1000-row cap
--   * page-first: only the requested page is ever enriched
--   * keyset pagination with a deterministic id tie-breaker (no OFFSET)
--   * sort_at = COALESCE(updated_at, created_at, epoch) -- there is no submitted_at column
--   * NEVER references audit_logs.organization_id (that column is not guaranteed to
--     exist); org scope is always inherited from the expense
--   * visibility and actionability are separate concerns
--
-- Verified columns only:
--   expenses(id, organization_id, user_id, status, approval_tier, category, title,
--            purpose, destination, total_amount, transaction_number, batch_id,
--            assigned_engineer_id, assigned_reviewer_id, created_at, updated_at)
--   profiles(user_id, organization_id, name, email, employee_id, balance, is_active,
--            reporting_engineer_id)
--   organization_memberships(organization_id, user_id, role, is_active)
--   teams(organization_id, manager_user_id, executive_user_id, team_leader_user_id)
--   team_members(organization_id, team_id, user_id)
--   audit_logs(id, action, comment, created_at, expense_id, user_id)
--   expense_correction_logs(expense_id, organization_id, created_at)
--   expense_form_field_values(id, organization_id, expense_id, template_id,
--                             branch_field_id, field_value)
--   expense_form_field_templates(id, organization_id, name, field_key, field_type, options)
--   expense_form_field_option_branches(id, organization_id, parent_template_id,
--                             parent_branch_id, parent_option_value, name, field_key,
--                             field_type, options, display_order)
-- =============================================================================

-- 1 ── Capability probe --------------------------------------------------------

CREATE OR REPLACE FUNCTION public.review_queue_api_version()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT 2 $$;

REVOKE ALL ON FUNCTION public.review_queue_api_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_queue_api_version() TO authenticated;

COMMENT ON FUNCTION public.review_queue_api_version() IS
  'Review Queue contract version. 2 = V2 JSONB contracts available (DOC-079).';


-- 2 ── Canonical visibility ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.reviewer_visible_user_ids_v2(
  p_organization_id uuid
)
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH caller AS (
    SELECT m.user_id, m.role::text AS role
    FROM public.organization_memberships m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = p_organization_id
      AND m.is_active = true
    LIMIT 1
  ),
  -- Reporting tree from the caller downwards. Depth guard + cycle protection.
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
        AND NOT p.user_id = ANY(w.path)      -- cycle protection
    )
    SELECT DISTINCT walk.user_id FROM walk
  ),
  -- Role-aware team ownership. Roles come from the real app_role enum, compared as
  -- text so a missing enum literal can never raise.
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
  -- Admins see the whole organization.
  admin_scope AS (
    SELECT p.user_id
    FROM public.profiles p, caller c
    WHERE c.role = 'admin'
      AND p.organization_id = p_organization_id
  ),
  candidates AS (
    SELECT tree.user_id FROM tree
    UNION SELECT team_scope.user_id FROM team_scope
    UNION SELECT admin_scope.user_id FROM admin_scope
  )
  -- Intersect with active membership so removed users drop out of scope.
  SELECT DISTINCT cand.user_id
  FROM candidates cand
  JOIN public.organization_memberships m
    ON m.user_id = cand.user_id
   AND m.organization_id = p_organization_id
   AND m.is_active = true
  WHERE EXISTS (SELECT 1 FROM caller);
$$;

REVOKE ALL ON FUNCTION public.reviewer_visible_user_ids_v2(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reviewer_visible_user_ids_v2(uuid) TO authenticated;

COMMENT ON FUNCTION public.reviewer_visible_user_ids_v2(uuid) IS
  'Users whose expenses the caller may SEE (not necessarily act on). DOC-079.';


-- 3 ── Review queue page (single JSONB) ---------------------------------------

CREATE OR REPLACE FUNCTION public.get_review_queue_page_v2(
  p_organization_id uuid,
  p_page_size integer DEFAULT 25,
  p_cursor jsonb DEFAULT NULL,
  p_sort text DEFAULT 'newest',
  p_search text DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_categories text[] DEFAULT NULL,
  p_user_ids uuid[] DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_actionable_only boolean DEFAULT false,
  p_custom_filters jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_size        integer := LEAST(GREATEST(COALESCE(p_page_size, 25), 1), 100);
  v_sort        text    := COALESCE(p_sort, 'newest');
  v_hierarchy   boolean;
  v_tl_tier     boolean;
  v_exec_tier   boolean;
  v_cur_sort_at timestamptz := NULL;
  v_cur_id      uuid        := NULL;
  v_cur_amount  numeric     := NULL;
  v_search      text;
  v_out         jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = p_organization_id
      AND m.is_active = true
  ) THEN
    RAISE EXCEPTION 'not an active member of this organization' USING ERRCODE = '42501';
  END IF;

  IF v_sort NOT IN ('newest', 'oldest', 'amount_high', 'amount_low') THEN
    RAISE EXCEPTION 'unsupported sort: %', v_sort USING ERRCODE = '22023';
  END IF;

  IF p_custom_filters IS NOT NULL AND jsonb_typeof(p_custom_filters) <> 'array' THEN
    RAISE EXCEPTION 'p_custom_filters must be a JSON array' USING ERRCODE = '22023';
  END IF;

  IF p_cursor IS NOT NULL AND jsonb_typeof(p_cursor) <> 'object' THEN
    RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(bool_or(f.enabled) FILTER (WHERE f.feature_key = 'approval_hierarchy'), false),
         COALESCE(bool_or(f.enabled) FILTER (WHERE f.feature_key = 'hierarchy_team_leader'), false),
         COALESCE(bool_or(f.enabled) FILTER (WHERE f.feature_key = 'hierarchy_executive'), false)
    INTO v_hierarchy, v_tl_tier, v_exec_tier
  FROM public.organization_features f
  WHERE f.organization_id = p_organization_id;

  v_search := NULLIF(btrim(COALESCE(p_search, '')), '');

  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_cur_sort_at := NULLIF(p_cursor->>'sort_at', '')::timestamptz;
      v_cur_id      := NULLIF(p_cursor->>'id', '')::uuid;
      v_cur_amount  := NULLIF(p_cursor->>'total_amount', '')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'malformed cursor' USING ERRCODE = '22023';
    END;
  END IF;

  -- Single statement, CTEs only. A STABLE function may not execute DDL, so the
  -- previous CREATE TEMP TABLE pipeline could never have run at all. MATERIALIZED
  -- pins the page-first shape so enrichment cannot be inlined back across the LIMIT.
  WITH visible AS MATERIALIZED (
    SELECT e.id, e.user_id, e.status::text AS status, e.approval_tier, e.category,
           e.title, e.purpose, e.destination, e.total_amount, e.transaction_number,
           e.batch_id, e.created_at, e.updated_at,
           COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) AS sort_at
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.status::text <> 'draft'
      AND (
           e.user_id IN (SELECT v.user_id FROM public.reviewer_visible_user_ids_v2(p_organization_id) v)
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid()
      )
  ),
  filtered AS MATERIALIZED (
    SELECT r.* FROM visible r
    WHERE (p_statuses   IS NULL OR r.status   = ANY(p_statuses))
      AND (p_categories IS NULL OR r.category = ANY(p_categories))
      AND (p_user_ids   IS NULL OR r.user_id  = ANY(p_user_ids))
      AND (p_date_from  IS NULL OR r.sort_at >= p_date_from::timestamptz)
      AND (p_date_to    IS NULL OR r.sort_at <  (p_date_to + 1)::timestamptz)
      AND (
        v_search IS NULL
        OR r.transaction_number ILIKE '%' || v_search || '%'
        OR r.title              ILIKE '%' || v_search || '%'
        OR r.destination        ILIKE '%' || v_search || '%'
        OR EXISTS (
             SELECT 1 FROM public.profiles p
             WHERE p.user_id = r.user_id
               AND p.organization_id = p_organization_id
               AND (p.name ILIKE '%' || v_search || '%'
                 OR p.email ILIKE '%' || v_search || '%'
                 OR p.employee_id ILIKE '%' || v_search || '%')
           )
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
  actionable AS MATERIALIZED (
    SELECT f.*, public._review_is_actionable_v2(f.status, f.approval_tier, f.id,
             v_hierarchy, v_tl_tier, v_exec_tier) AS is_actionable
    FROM filtered f
  ),
  eligible AS MATERIALIZED (
    SELECT a.* FROM actionable a
    WHERE (NOT p_actionable_only) OR a.is_actionable
  ),
  tot AS (SELECT count(*) AS total FROM eligible),
  page_rows AS MATERIALIZED (
    SELECT e.*,
           row_number() OVER (
             ORDER BY
               CASE WHEN v_sort = 'newest'      THEN e.sort_at END DESC,
               CASE WHEN v_sort = 'oldest'      THEN e.sort_at END ASC,
               CASE WHEN v_sort = 'amount_high' THEN e.total_amount END DESC NULLS LAST,
               CASE WHEN v_sort = 'amount_low'  THEN e.total_amount END ASC  NULLS LAST,
               CASE WHEN v_sort = 'amount_high' THEN e.sort_at END DESC,
               CASE WHEN v_sort = 'amount_low'  THEN e.sort_at END DESC,
               CASE WHEN v_sort = 'oldest' THEN e.id END ASC,
               e.id DESC
           ) AS rn
    FROM eligible e
    WHERE CASE v_sort
      WHEN 'newest' THEN v_cur_id IS NULL OR (e.sort_at, e.id) < (v_cur_sort_at, v_cur_id)
      WHEN 'oldest' THEN v_cur_id IS NULL OR (e.sort_at, e.id) > (v_cur_sort_at, v_cur_id)
      WHEN 'amount_high' THEN v_cur_id IS NULL
        OR (COALESCE(e.total_amount, '-Infinity'::numeric), e.sort_at, e.id)
           < (COALESCE(v_cur_amount, '-Infinity'::numeric), v_cur_sort_at, v_cur_id)
      WHEN 'amount_low' THEN v_cur_id IS NULL
        OR (COALESCE(e.total_amount, 'Infinity'::numeric), e.sort_at, e.id)
           > (COALESCE(v_cur_amount, 'Infinity'::numeric), v_cur_sort_at, v_cur_id)
      ELSE true END
    ORDER BY
      CASE WHEN v_sort = 'newest'      THEN e.sort_at END DESC,
      CASE WHEN v_sort = 'oldest'      THEN e.sort_at END ASC,
      CASE WHEN v_sort = 'amount_high' THEN e.total_amount END DESC NULLS LAST,
      CASE WHEN v_sort = 'amount_low'  THEN e.total_amount END ASC  NULLS LAST,
      CASE WHEN v_sort = 'amount_high' THEN e.sort_at END DESC,
      CASE WHEN v_sort = 'amount_low'  THEN e.sort_at END DESC,
      CASE WHEN v_sort = 'oldest' THEN e.id END ASC,
      e.id DESC
    LIMIT v_size
  ),
  -- Identity resolved server-side, for page users only. An inactive employee keeps
  -- their history, so a failed browser profile call can no longer blank a row.
  page_identity AS MATERIALIZED (
    SELECT p.user_id,
           COALESCE(NULLIF(btrim(p.name), ''), 'Unknown employee') AS employee_name,
           p.email AS employee_email,
           p.employee_id,
           COALESCE(p.balance, 0) AS current_balance,
           CASE WHEN COALESCE(p.is_active, true) THEN 'current_profile'
                ELSE 'inactive_profile' END AS identity_source
    FROM public.profiles p
    WHERE p.organization_id = p_organization_id
      AND p.user_id IN (SELECT DISTINCT pr.user_id FROM page_rows pr)
  ),
  page_custom_fields AS MATERIALIZED (
    SELECT c.expense_id,
           jsonb_agg(jsonb_build_object('source', c.source, 'field_id', c.field_id,
             'field_key', c.field_key, 'label', c.label, 'value', c.value)) AS fields
    FROM (
      SELECT fv.expense_id, 'template'::text AS source, t.id AS field_id,
             COALESCE(t.field_key, t.id::text) AS field_key,
             COALESCE(t.name, t.field_key) AS label, fv.field_value AS value
      FROM public.expense_form_field_values fv
      JOIN public.expense_form_field_templates t ON t.id = fv.template_id
      WHERE fv.organization_id = p_organization_id
        AND fv.expense_id IN (SELECT pr.id FROM page_rows pr)
      UNION ALL
      SELECT fv.expense_id, 'branch', b.id, COALESCE(b.field_key, b.id::text),
             COALESCE(b.name, b.field_key), fv.field_value
      FROM public.expense_form_field_values fv
      JOIN public.expense_form_field_option_branches b ON b.id = fv.branch_field_id
      WHERE fv.organization_id = p_organization_id
        AND fv.expense_id IN (SELECT pr.id FROM page_rows pr)
    ) c
    GROUP BY c.expense_id
  ),
  items AS (
    SELECT jsonb_agg(jsonb_build_object(
             'id', pr.id,
             'transaction_number', pr.transaction_number,
             'batch_id', pr.batch_id,
             'user_id', pr.user_id,
             'employee_name', COALESCE(pi.employee_name, 'Unknown employee'),
             'employee_email', pi.employee_email,
             'employee_id', pi.employee_id,
             'identity_source', COALESCE(pi.identity_source, 'unresolved'),
             'current_balance', COALESCE(pi.current_balance, 0),
             'title', pr.title,
             'purpose', pr.purpose,
             'category', pr.category,
             'destination', pr.destination,
             'total_amount', pr.total_amount,
             'status', pr.status,
             'approval_tier', pr.approval_tier,
             'created_at', pr.created_at,
             'updated_at', pr.updated_at,
             'sort_at', pr.sort_at,
             'is_resubmitted', EXISTS (
               SELECT 1 FROM public.audit_logs al
               WHERE al.expense_id = pr.id AND al.action = 'expense_resubmitted'),
             'was_reviewer_corrected', EXISTS (
               SELECT 1 FROM public.expense_correction_logs cl
               WHERE cl.expense_id = pr.id AND cl.organization_id = p_organization_id),
             'is_actionable', pr.is_actionable,
             'actionable_reason', public._review_actionable_reason_v2(
               pr.status, pr.approval_tier, pr.id, v_hierarchy, v_tl_tier, v_exec_tier),
             'actionable_stage', CASE pr.approval_tier
               WHEN 'team_leader' THEN 'team_leader' WHEN 'executive' THEN 'executive'
               WHEN 'engineer' THEN 'engineer' WHEN 'admin' THEN 'admin' ELSE NULL END,
             'custom_fields', COALESCE(pcf.fields, '[]'::jsonb)
           ) ORDER BY pr.rn) AS arr,
           count(*) AS n
    FROM page_rows pr
    LEFT JOIN page_identity pi ON pi.user_id = pr.user_id
    LEFT JOIN page_custom_fields pcf ON pcf.expense_id = pr.id
  ),
  last_row AS (
    -- Exactly the final returned row, by the same row_number() that ordered the
    -- page. No inverse-ordering approximation.
    SELECT pr.sort_at, pr.id, pr.total_amount
    FROM page_rows pr
    ORDER BY pr.rn DESC
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'version', 2,
    'sort', v_sort,
    'page_size', v_size,
    'total', (SELECT total FROM tot),
    'next_cursor', CASE WHEN COALESCE((SELECT n FROM items), 0) = v_size
      THEN (SELECT jsonb_build_object('sort_at', lr.sort_at, 'id', lr.id,
                     'total_amount', lr.total_amount) FROM last_row lr)
      ELSE NULL END,
    'items', COALESCE((SELECT arr FROM items), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_review_queue_page_v2(uuid, integer, jsonb, text, text, text[], text[], uuid[], date, date, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_review_queue_page_v2(uuid, integer, jsonb, text, text, text[], text[], uuid[], date, date, boolean, jsonb) TO authenticated;


-- 4 ── Actionability helpers (ported from managerActionableExpenses.ts) --------
-- Terminal -> false; level_2_verified -> true; engineer tier -> actionable status;
-- executive handoff -> true; skipped tier -> true; hierarchy off -> actionable status.

CREATE OR REPLACE FUNCTION public._review_manager_actionable_status_v2(p_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT p_status IN ('submitted','edited','under_review','level_1_verified','level_2_verified');
$$;

CREATE OR REPLACE FUNCTION public._review_executive_handoff_v2(p_expense_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  -- Scoped through the expense; audit_logs.organization_id is never referenced.
  SELECT EXISTS (
    SELECT 1 FROM public.audit_logs al
    WHERE al.expense_id = p_expense_id
      AND al.action = 'tier_advanced'
      AND (lower(COALESCE(al.comment,'')) LIKE '%advanced to engineer%'
        OR (lower(COALESCE(al.comment,'')) LIKE '%verified at executive%'
            AND lower(COALESCE(al.comment,'')) LIKE '%advanced to%'))
  );
$$;

CREATE OR REPLACE FUNCTION public._review_skipped_tier_v2(
  p_tier text, p_hierarchy boolean, p_tl boolean, p_exec boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN NOT p_hierarchy OR p_tier IS NULL THEN false
    WHEN p_tier = 'team_leader' THEN NOT p_tl
    WHEN p_tier = 'executive'   THEN NOT p_exec
    ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public._review_is_actionable_v2(
  p_status text, p_tier text, p_expense_id uuid,
  p_hierarchy boolean, p_tl boolean, p_exec boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_status IN ('verified','approved','rejected') THEN false
    WHEN p_status = 'level_2_verified' THEN true
    WHEN p_tier = 'engineer' THEN public._review_manager_actionable_status_v2(p_status)
    WHEN public._review_executive_handoff_v2(p_expense_id) THEN true
    WHEN public._review_skipped_tier_v2(p_tier, p_hierarchy, p_tl, p_exec)
         AND public._review_manager_actionable_status_v2(p_status) THEN true
    WHEN NOT p_hierarchy AND public._review_manager_actionable_status_v2(p_status) THEN true
    ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public._review_actionable_reason_v2(
  p_status text, p_tier text, p_expense_id uuid,
  p_hierarchy boolean, p_tl boolean, p_exec boolean)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_status IN ('verified','approved','rejected') THEN 'completed'
    WHEN public._review_is_actionable_v2(p_status, p_tier, p_expense_id, p_hierarchy, p_tl, p_exec)
      THEN 'ready'
    ELSE 'wrong_tier' END;
$$;


-- 5 ── Filter options ----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_review_filter_options_v2(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.organization_id = p_organization_id AND m.is_active = true
  ) THEN
    RAISE EXCEPTION 'not an active member of this organization' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'version', 2,
    'statuses', to_jsonb(ARRAY['submitted','verified','approved','rejected','edited',
                               'under_review','level_1_verified','level_2_verified']),
    'categories', COALESCE((
      SELECT jsonb_agg(DISTINCT e.category)
      FROM public.expenses e
      WHERE e.organization_id = p_organization_id AND e.category IS NOT NULL), '[]'::jsonb),
    'employees', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', p.user_id, 'name', COALESCE(p.name,'Unknown employee'),
               'employee_id', p.employee_id))
      FROM public.profiles p
      JOIN public.reviewer_visible_user_ids_v2(p_organization_id) v ON v.user_id = p.user_id
      WHERE p.organization_id = p_organization_id), '[]'::jsonb),
    -- Definitions only. Expense values are never scanned here.
    'custom_fields', COALESCE((
      SELECT jsonb_agg(d) FROM (
        SELECT jsonb_build_object('source','template','field_id',t.id,
                 'field_key',COALESCE(t.field_key,t.id::text),
                 'label',COALESCE(t.name,t.field_key),'options',t.options) AS d
        FROM public.expense_form_field_templates t
        WHERE t.organization_id = p_organization_id
        UNION ALL
        SELECT jsonb_build_object('source','branch','field_id',b.id,
                 'field_key',COALESCE(b.field_key,b.id::text),
                 'label',COALESCE(b.name,b.field_key),'options',b.options)
        FROM public.expense_form_field_option_branches b
        WHERE b.organization_id = p_organization_id
      ) q), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_review_filter_options_v2(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_review_filter_options_v2(uuid) TO authenticated;


-- 6 ── Detail ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_review_expense_detail_v2(
  p_organization_id uuid,
  p_expense_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_out jsonb; v_visible boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.organization_id = p_organization_id AND m.is_active = true
  ) THEN
    RAISE EXCEPTION 'not an active member of this organization' USING ERRCODE = '42501';
  END IF;

  -- Re-check visibility; never trust a client-supplied id.
  SELECT EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = p_expense_id
      AND e.organization_id = p_organization_id
      AND (e.user_id IN (SELECT v.user_id FROM public.reviewer_visible_user_ids_v2(p_organization_id) v)
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid())
  ) INTO v_visible;

  IF NOT v_visible THEN
    RAISE EXCEPTION 'expense not visible to this reviewer' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'version', 2,
    'expense', to_jsonb(e) ||
       jsonb_build_object('sort_at', COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz)),
    'submitter', COALESCE((
      SELECT jsonb_build_object('user_id',p.user_id,'name',COALESCE(p.name,'Unknown employee'),
               'email',p.email,'employee_id',p.employee_id,'balance',COALESCE(p.balance,0))
      FROM public.profiles p
      WHERE p.user_id = e.user_id AND p.organization_id = p_organization_id), '{}'::jsonb),
    'custom_fields', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('source',c.source,'field_id',c.field_id,
               'field_key',c.field_key,'label',c.label,'value',c.value))
      FROM (
        SELECT 'template'::text AS source, t.id AS field_id,
               COALESCE(t.field_key,t.id::text) AS field_key,
               COALESCE(t.name,t.field_key) AS label, fv.field_value AS value
        FROM public.expense_form_field_values fv
        JOIN public.expense_form_field_templates t ON t.id = fv.template_id
        WHERE fv.expense_id = e.id AND fv.organization_id = p_organization_id
        UNION ALL
        SELECT 'branch', b.id, COALESCE(b.field_key,b.id::text),
               COALESCE(b.name,b.field_key), fv.field_value
        FROM public.expense_form_field_values fv
        JOIN public.expense_form_field_option_branches b ON b.id = fv.branch_field_id
        WHERE fv.expense_id = e.id AND fv.organization_id = p_organization_id
      ) c), '[]'::jsonb),
    'attachments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,
               'content_type',a.content_type,'file_url',a.file_url))
      FROM public.attachments a WHERE a.expense_id = e.id), '[]'::jsonb),
    'timeline', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',al.id,'action',al.action,
               'comment',al.comment,'user_id',al.user_id,'created_at',al.created_at)
             ORDER BY al.created_at)
      FROM public.audit_logs al WHERE al.expense_id = e.id), '[]'::jsonb),
    'corrections', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',cl.id,'edited_by',cl.edited_by,
               'reason',cl.reason,'created_at',cl.created_at) ORDER BY cl.created_at DESC)
      FROM public.expense_correction_logs cl
      WHERE cl.expense_id = e.id AND cl.organization_id = p_organization_id), '[]'::jsonb)
  ) INTO v_out
  FROM public.expenses e
  WHERE e.id = p_expense_id;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_review_expense_detail_v2(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_review_expense_detail_v2(uuid, uuid) TO authenticated;


-- 7 ── Indexes (confirmed columns only; audit_logs.organization_id NOT used) ----

CREATE INDEX IF NOT EXISTS expenses_rq2_org_sort_idx
  ON public.expenses (organization_id, (COALESCE(updated_at, created_at)) DESC, id DESC);

CREATE INDEX IF NOT EXISTS expenses_rq2_org_user_sort_idx
  ON public.expenses (organization_id, user_id, (COALESCE(updated_at, created_at)) DESC, id DESC);

CREATE INDEX IF NOT EXISTS expenses_rq2_org_status_sort_idx
  ON public.expenses (organization_id, status, (COALESCE(updated_at, created_at)) DESC, id DESC);

CREATE INDEX IF NOT EXISTS expenses_rq2_assigned_engineer_idx
  ON public.expenses (assigned_engineer_id) WHERE assigned_engineer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS expenses_rq2_assigned_reviewer_idx
  ON public.expenses (assigned_reviewer_id) WHERE assigned_reviewer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_rq2_org_reporting_idx
  ON public.profiles (organization_id, reporting_engineer_id, user_id);

CREATE INDEX IF NOT EXISTS org_memberships_rq2_active_idx
  ON public.organization_memberships (organization_id, user_id, is_active, role);

CREATE INDEX IF NOT EXISTS teams_rq2_manager_idx   ON public.teams (organization_id, manager_user_id);
CREATE INDEX IF NOT EXISTS teams_rq2_executive_idx ON public.teams (organization_id, executive_user_id);
CREATE INDEX IF NOT EXISTS teams_rq2_leader_idx    ON public.teams (organization_id, team_leader_user_id);

CREATE INDEX IF NOT EXISTS team_members_rq2_idx
  ON public.team_members (organization_id, team_id, user_id);

-- audit_logs: expense-scoped only. No organization_id reference.
CREATE INDEX IF NOT EXISTS audit_logs_rq2_action_expense_idx
  ON public.audit_logs (action, expense_id);
CREATE INDEX IF NOT EXISTS audit_logs_rq2_user_action_expense_idx
  ON public.audit_logs (user_id, action, expense_id);

CREATE INDEX IF NOT EXISTS correction_logs_rq2_org_expense_idx
  ON public.expense_correction_logs (organization_id, expense_id);

CREATE INDEX IF NOT EXISTS effv_rq2_org_expense_idx
  ON public.expense_form_field_values (organization_id, expense_id);
CREATE INDEX IF NOT EXISTS effv_rq2_template_filter_idx
  ON public.expense_form_field_values (organization_id, template_id, field_value, expense_id)
  WHERE template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS effv_rq2_branch_filter_idx
  ON public.expense_form_field_values (organization_id, branch_field_id, field_value, expense_id)
  WHERE branch_field_id IS NOT NULL;

-- NOTE: CREATE INDEX (non-CONCURRENTLY) takes a SHARE lock on each table for the
-- duration of the build, blocking writes. On ~6k expenses this is short, but apply
-- during a quiet window. CONCURRENTLY is deliberately not used because Supabase
-- runs migrations inside a transaction.
