-- =============================================================================
-- Debug Review Queue v1 — corrections (DOC-080)
--
-- ADDITIVE. 20260801140000 has already been applied to a shared environment
-- (capabilities reported ready=true on 2026-08-01T18:11:59Z), so that file is
-- NOT rewritten. Every change lives here.
--
-- Column audit result (information_schema, 2026-08-01): every column referenced
-- by 20260801140000 exists. expense_correction_logs.{id,edited_by,reason},
-- expense_form_field_templates.{field_key,name,options},
-- expense_form_field_option_branches.{field_key,name,options} and
-- attachments.{filename,content_type,file_url} are all present. No invalid
-- reference needed fixing.
--
-- What IS corrected here:
--
--  1. ACTIONABILITY. 20260801140000 approximated it as
--     `status NOT IN ('verified','approved','rejected')`, which ignores the
--     caller's role, the approval tier, hierarchy enablement, skipped tiers,
--     direct assignment and executive handoff. Replaced by ONE canonical helper,
--     _debug_review_actionability_v1, ported from canRoleActOnExpense()
--     (src/lib/approvalHierarchy.ts) and computeManagerQueueReady()
--     (src/lib/managerActionableExpenses.ts). Employee-search counts, KPI counts
--     and queue rows all call that single helper — there is no second definition.
--
--  2. IDENTITY CARDINALITY. Profile enrichment joined on user_id with no
--     uniqueness guarantee, so a duplicate profile row would DUPLICATE expense
--     rows. Replaced by _debug_review_resolve_identity_v1, which returns at most
--     one row per user_id and reports identity_issue='duplicate_profiles'
--     instead of silently picking an arbitrary duplicate.
--
--  3. KEYSET NULL HANDLING. Tuple comparisons such as
--     `(f.created_at, f.id) < (v_c_ts, v_c_id)` evaluate to NULL — not false —
--     when created_at/trip_start/total_amount is NULL, which silently DROPS
--     those rows from every page after the first. Replaced by a single finite
--     numeric sort key (sk) that folds direction and null policy into one always-
--     ascending comparison, so all six sorts share one null-free code path.
--
--  4. SOFT-DELETED ATTACHMENTS. attachments.deleted_at exists (DOC-078). The
--     detail RPC returned deleted rows as if they were live.
--
--  5. selected_employee came from a direct profiles SELECT that returns no row
--     when the profile is missing, so the selection silently vanished. It is now
--     derived from the authorized selected user id plus the identity resolver.
--
-- All functions: SECURITY DEFINER, SET search_path = '', fully-qualified,
-- PUBLIC and anon revoked, authenticated only. No table DDL. No data changes.
-- =============================================================================


-- 1 ── Caller context: role + hierarchy flags, resolved once per request -------

CREATE OR REPLACE FUNCTION public._debug_review_caller_context_v1(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH role AS (
    SELECT m.role::text AS role
    FROM public.organization_memberships m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = p_organization_id
      AND m.is_active = true
    LIMIT 1
  ),
  flags AS (
    SELECT
      bool_or(f.feature_key = 'approval_hierarchy'   AND f.enabled) AS hier,
      bool_or(f.feature_key = 'hierarchy_team_leader' AND f.enabled) AS tl,
      bool_or(f.feature_key = 'hierarchy_executive'   AND f.enabled) AS exec
    FROM public.organization_features f
    WHERE f.organization_id = p_organization_id
      AND f.feature_key IN ('approval_hierarchy','hierarchy_team_leader','hierarchy_executive')
  )
  SELECT jsonb_build_object(
    'caller_user_id', auth.uid(),
    'role', (SELECT role FROM role),
    -- buildHierarchyFlags(): the tier flags are meaningless unless the master
    -- approval_hierarchy flag is on, so they are AND-ed with it here too.
    'hierarchy_enabled',    coalesce((SELECT hier FROM flags), false),
    'team_leader_enabled',  coalesce((SELECT hier FROM flags), false)
                            AND coalesce((SELECT tl   FROM flags), false),
    'executive_enabled',    coalesce((SELECT hier FROM flags), false)
                            AND coalesce((SELECT exec FROM flags), false)
  );
$$;

REVOKE ALL ON FUNCTION public._debug_review_caller_context_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_caller_context_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_caller_context_v1(uuid) TO authenticated;


-- 2 ── THE canonical actionability helper --------------------------------------
-- Pure: no table access, so it is safe to call once per row. This is the single
-- definition — employee-search counts, KPI counts and queue rows all use it.

CREATE OR REPLACE FUNCTION public._debug_review_actionability_v1(
  p_role               text,
  p_caller             uuid,
  p_status             text,
  p_tier               text,
  p_assigned_reviewer  uuid,
  p_assigned_engineer  uuid,
  p_hierarchy_enabled  boolean,
  p_team_leader_enabled boolean,
  p_executive_enabled  boolean,
  p_handoff            boolean
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  -- MANAGER_ACTIONABLE_STATUSES, verbatim from managerActionableExpenses.ts
  v_open_statuses text[] := ARRAY['submitted','edited','under_review',
                                  'level_1_verified','level_2_verified'];
  v_terminal      boolean := p_status IN ('verified','approved','rejected');
  v_is_reviewer   boolean := p_assigned_reviewer IS NOT NULL AND p_assigned_reviewer = p_caller;
  v_is_engineer   boolean := p_assigned_engineer IS NOT NULL AND p_assigned_engineer = p_caller;
  v_open          boolean := p_status = ANY(v_open_statuses);
  v_can_verify    boolean;
  v_can_act       boolean;
  v_queue_ready   boolean;
  v_skipped       boolean;
  v_actionable    boolean;
  v_stage         text;
  v_reason        text;
  v_actions       jsonb;
BEGIN
  -- canRoleVerifyAtTier(role, tier)
  v_can_verify := CASE
    WHEN p_tier IS NULL          THEN p_role IN ('engineer','admin')
    WHEN p_tier = 'team_leader'  THEN p_role = 'team_leader'
    WHEN p_tier = 'executive'    THEN p_role = 'executive'
    WHEN p_tier = 'engineer'     THEN p_role = 'engineer'
    ELSE p_role = 'admin'
  END;

  -- canRoleActOnExpense(role, tier, assignedReviewerId, userId, assignedEngineerId)
  v_can_act := CASE
    WHEN p_role = 'admin' AND p_tier = 'admin' THEN true
    WHEN NOT (v_is_reviewer OR v_is_engineer)  THEN false
    WHEN p_tier IS NULL THEN p_role IN ('team_leader','executive') AND v_is_engineer
    WHEN v_is_reviewer AND v_can_verify THEN true
    WHEN v_is_engineer AND (
           v_can_verify
        OR (p_role = 'team_leader' AND p_tier = 'team_leader')
        OR (p_role = 'executive'   AND p_tier = 'executive')
    ) THEN true
    ELSE false
  END;

  -- isSkippedHierarchyTier(): routing skipped this tier because it is disabled.
  v_skipped := p_hierarchy_enabled AND p_tier IS NOT NULL AND (
       (p_tier = 'team_leader' AND NOT coalesce(p_team_leader_enabled, false))
    OR (p_tier = 'executive'   AND NOT coalesce(p_executive_enabled, false))
  );

  -- computeManagerQueueReady(): gates the engineer/admin end of the pipeline.
  v_queue_ready := CASE
    WHEN v_terminal                     THEN false
    WHEN p_status = 'level_2_verified'  THEN true
    WHEN p_tier = 'engineer'            THEN v_open
    WHEN coalesce(p_handoff, false)     THEN true
    WHEN v_skipped AND v_open           THEN true
    WHEN NOT p_hierarchy_enabled AND v_open THEN true
    ELSE false
  END;

  IF v_terminal THEN
    RETURN jsonb_build_object(
      'is_actionable', false,
      'actionable_stage', 'terminal',
      'actionable_reason', 'status_' || p_status,
      'available_actions', '[]'::jsonb,
      'view_only', true);
  END IF;

  -- Tier reviewers act on their own tier; engineer/admin additionally need the
  -- queue-ready gate so rows still sitting at a lower tier are not offered.
  IF p_role IN ('team_leader','executive') THEN
    v_actionable := v_can_act AND v_open;
  ELSE
    v_actionable := v_can_act AND v_queue_ready;
  END IF;

  v_stage := coalesce(p_tier, 'engineer');

  v_reason := CASE
    WHEN v_actionable                          THEN 'actionable_at_' || v_stage
    WHEN NOT (v_is_reviewer OR v_is_engineer)
         AND NOT (p_role = 'admin' AND p_tier = 'admin') THEN 'not_assigned_to_caller'
    WHEN NOT v_can_act                         THEN 'role_cannot_act_at_' || v_stage
    WHEN NOT v_open                            THEN 'status_not_open'
    WHEN NOT v_queue_ready                     THEN 'awaiting_' || v_stage || '_tier'
    ELSE 'not_actionable'
  END;

  v_actions := CASE
    WHEN NOT v_actionable                       THEN '[]'::jsonb
    WHEN p_role IN ('team_leader','executive')  THEN '["verify","reject"]'::jsonb
    ELSE '["approve","reject","correct"]'::jsonb
  END;

  RETURN jsonb_build_object(
    'is_actionable', v_actionable,
    'actionable_stage', v_stage,
    'actionable_reason', v_reason,
    'available_actions', v_actions,
    'view_only', NOT v_actionable);
END;
$$;

REVOKE ALL ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) TO authenticated;

COMMENT ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) IS
  'THE canonical debug actionability definition (DOC-080). Ported from canRoleActOnExpense + computeManagerQueueReady. Do not add a second definition.';


-- 3 ── Executive-handoff ids (tier_advanced audit trail) -----------------------

CREATE OR REPLACE FUNCTION public._debug_review_handoff_ids_v1(
  p_organization_id uuid
)
RETURNS TABLE(expense_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT al.expense_id
  FROM public.audit_logs al
  WHERE al.organization_id = p_organization_id
    AND al.action = 'tier_advanced'
    AND al.expense_id IS NOT NULL
    AND (
         lower(coalesce(al.comment,'')) LIKE '%advanced to engineer%'
      OR (lower(coalesce(al.comment,'')) LIKE '%verified at executive%'
          AND lower(coalesce(al.comment,'')) LIKE '%advanced to%')
    );
$$;

REVOKE ALL ON FUNCTION public._debug_review_handoff_ids_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_handoff_ids_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_handoff_ids_v1(uuid) TO authenticated;


-- 4 ── Identity resolver: AT MOST ONE row per user_id --------------------------
-- A duplicate profile must never duplicate an expense row, and must never be
-- resolved by silently picking one arbitrarily.

CREATE OR REPLACE FUNCTION public._debug_review_resolve_identity_v1(
  p_organization_id uuid,
  p_user_ids uuid[]
)
RETURNS TABLE(
  user_id uuid,
  employee_name text,
  employee_email text,
  employee_id text,
  current_balance numeric,
  identity_source text,
  identity_issue text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH wanted AS (
    SELECT DISTINCT u AS user_id FROM unnest(coalesce(p_user_ids, ARRAY[]::uuid[])) AS u
  ),
  rows AS (
    SELECT p.user_id, p.name, p.email, p.employee_id, p.balance,
           coalesce(p.is_active, true) AS is_active
    FROM public.profiles p
    JOIN wanted w ON w.user_id = p.user_id
    WHERE p.organization_id = p_organization_id
  ),
  agg AS (
    SELECT r.user_id,
           count(*) AS total,
           count(*) FILTER (WHERE r.is_active) AS active_n
    FROM rows r GROUP BY r.user_id
  ),
  -- Deterministic pick: active first, then a stable ordering on the identity
  -- columns themselves. Only TRUSTED when the pick is unambiguous (see below).
  picked AS (
    SELECT DISTINCT ON (r.user_id) r.*
    FROM rows r
    ORDER BY r.user_id, r.is_active DESC,
             r.employee_id NULLS LAST, r.name NULLS LAST, r.email NULLS LAST
  )
  SELECT
    w.user_id,
    CASE WHEN pk.user_id IS NULL THEN 'Unknown employee'
         WHEN a.total > 1 AND a.active_n <> 1 THEN 'Unknown employee'
         ELSE coalesce(nullif(btrim(pk.name), ''), 'Unknown employee') END,
    CASE WHEN a.total > 1 AND a.active_n <> 1 THEN NULL ELSE pk.email END,
    CASE WHEN a.total > 1 AND a.active_n <> 1 THEN NULL ELSE pk.employee_id END,
    CASE WHEN a.total > 1 AND a.active_n <> 1 THEN 0 ELSE coalesce(pk.balance, 0) END,
    CASE
      WHEN pk.user_id IS NULL                     THEN 'unresolved'
      WHEN a.total > 1 AND a.active_n <> 1        THEN 'unresolved'
      WHEN pk.is_active                           THEN 'current_profile'
      ELSE 'inactive_profile'
    END,
    CASE
      WHEN pk.user_id IS NULL              THEN 'profile_missing'
      WHEN a.total > 1 AND a.active_n <> 1 THEN 'duplicate_profiles'
      ELSE NULL
    END
  FROM wanted w
  LEFT JOIN picked pk ON pk.user_id = w.user_id
  LEFT JOIN agg    a  ON a.user_id  = w.user_id;
$$;

REVOKE ALL ON FUNCTION public._debug_review_resolve_identity_v1(uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_resolve_identity_v1(uuid,uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_resolve_identity_v1(uuid,uuid[]) TO authenticated;

COMMENT ON FUNCTION public._debug_review_resolve_identity_v1(uuid,uuid[]) IS
  'Returns at most one identity row per user_id. Reports duplicate_profiles instead of picking an arbitrary duplicate (DOC-080 Phase 5).';


-- 5 ── Employee search: actionable counts now use the canonical helper ---------

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
  v_ctx   jsonb;
  v_out   jsonb;
BEGIN
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);
  v_ctx := public._debug_review_caller_context_v1(p_organization_id);

  IF v_q IS NULL THEN
    RETURN jsonb_build_object('contract','debug-review-employee-search','version',1,
                              'query',NULL,'matches','[]'::jsonb);
  END IF;

  WITH handoff AS (
    SELECT h.expense_id FROM public._debug_review_handoff_ids_v1(p_organization_id) h
  ),
  visible_expenses AS (
    SELECT e.id, e.user_id, e.status::text AS status, e.approval_tier,
           e.assigned_reviewer_id, e.assigned_engineer_id
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
  scored AS (
    SELECT ve.user_id,
           (public._debug_review_actionability_v1(
              v_ctx->>'role', (v_ctx->>'caller_user_id')::uuid,
              ve.status, ve.approval_tier,
              ve.assigned_reviewer_id, ve.assigned_engineer_id,
              (v_ctx->>'hierarchy_enabled')::boolean,
              (v_ctx->>'team_leader_enabled')::boolean,
              (v_ctx->>'executive_enabled')::boolean,
              EXISTS (SELECT 1 FROM handoff h WHERE h.expense_id = ve.id)
            )->>'is_actionable')::boolean AS is_actionable
    FROM visible_expenses ve
  ),
  counts AS (
    SELECT s.user_id,
           count(*) AS visible_expense_count,
           count(*) FILTER (WHERE s.is_actionable) AS actionable_expense_count
    FROM scored s GROUP BY s.user_id
  ),
  ident AS (
    SELECT * FROM public._debug_review_resolve_identity_v1(
      p_organization_id, ARRAY(SELECT c.user_id FROM counts c))
  ),
  ranked AS (
    SELECT i.user_id, i.employee_name, i.employee_id, i.employee_email,
           i.identity_source, i.identity_issue,
           c.visible_expense_count, c.actionable_expense_count,
           -- Employee-only fields. transaction_number is deliberately absent:
           -- that separation is what stops the 6174 / 06174 collision.
           CASE
             WHEN lower(btrim(coalesce(i.employee_id,''))) = lower(v_q) THEN 'exact_employee_id'
             WHEN lower(btrim(coalesce(i.employee_name,''))) = lower(v_q) THEN 'exact_employee_name'
             WHEN lower(btrim(coalesce(i.employee_name,''))) LIKE lower(v_q) || '%' THEN 'name_prefix'
             WHEN lower(btrim(coalesce(i.employee_name,''))) LIKE '%' || lower(v_q) || '%' THEN 'name_contains'
             WHEN lower(btrim(coalesce(i.employee_email,''))) = lower(v_q) THEN 'exact_email'
             ELSE NULL
           END AS match_type
    FROM ident i
    JOIN counts c ON c.user_id = i.user_id
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
        'identity_issue', r.identity_issue,
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


-- 6 ── Queue page: null-safe keyset, deduped identity, canonical actionability --

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
  -- Finite sentinels. Using ±infinity would reintroduce NULL-ish comparison
  -- edge cases on numeric in older servers; these are safely out of range for
  -- epoch seconds and for any real expense amount.
  v_hi     numeric := 1e30;
  v_lo     numeric := -1e30;
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

  -- A cursor is only meaningful for the sort that produced it. Rather than
  -- silently returning the wrong slice, a mismatched cursor resets to page 1.
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
  visible AS MATERIALIZED (
    SELECT e.id, e.user_id, e.status::text AS status, e.approval_tier, e.category,
           e.title, e.purpose, e.destination, e.total_amount, e.transaction_number,
           e.batch_id, e.created_at, e.trip_start,
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
  -- Canonical actionability, once per visible row. KPI counts, employee counts
  -- and row flags therefore cannot disagree.
  acted AS MATERIALIZED (
    SELECT v.*,
           public._debug_review_actionability_v1(
             v_ctx->>'role', (v_ctx->>'caller_user_id')::uuid,
             v.status, v.approval_tier,
             v.assigned_reviewer_id, v.assigned_engineer_id,
             (v_ctx->>'hierarchy_enabled')::boolean,
             (v_ctx->>'team_leader_enabled')::boolean,
             (v_ctx->>'executive_enabled')::boolean,
             v.handoff
           ) AS act
    FROM visible v
  ),
  scope_summary AS (
    SELECT count(*) FILTER (WHERE a.assigned_reviewer_id = auth.uid()
                               OR a.assigned_engineer_id = auth.uid()) AS assigned_to_me,
           count(*) FILTER (WHERE (a.act->>'is_actionable')::boolean) AS pending_review,
           count(*) FILTER (WHERE a.status IN ('verified','level_1_verified','level_2_verified')) AS verified,
           coalesce(sum(a.total_amount), 0) AS total_amount,
           count(*) AS scope_total
    FROM acted a
  ),
  filtered AS MATERIALIZED (
    SELECT r.* FROM acted r
    WHERE
      -- EXACT immutable user_id. Never consults transaction_number — that is
      -- precisely what caused the 6174 / 06174 collision.
      (p_employee_user_id IS NULL OR r.user_id = p_employee_user_id)
      AND (p_statuses   IS NULL OR r.status   = ANY(p_statuses))
      AND (p_categories IS NULL OR r.category = ANY(p_categories))
      AND (p_date_from  IS NULL OR r.trip_start >= p_date_from)
      AND (p_date_to    IS NULL OR r.trip_start <= p_date_to)
      AND (coalesce(p_actionable_only, false) = false
           OR (r.act->>'is_actionable')::boolean)
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
  ),
  tot AS (SELECT count(*) AS filtered_total FROM filtered),
  -- ONE finite, non-null sort key folding direction + null policy together, so
  -- every sort uses the same always-ascending, never-NULL comparison. NULLs get
  -- a sentinel that always lands last.
  keyed AS MATERIALIZED (
    SELECT f.*,
           CASE v_sort
             WHEN 'created_desc'      THEN -coalesce(extract(epoch FROM f.created_at)::numeric, v_lo)
             WHEN 'created_asc'       THEN  coalesce(extract(epoch FROM f.created_at)::numeric, v_hi)
             WHEN 'expense_date_desc' THEN -coalesce(extract(epoch FROM f.trip_start::timestamp)::numeric, v_lo)
             WHEN 'expense_date_asc'  THEN  coalesce(extract(epoch FROM f.trip_start::timestamp)::numeric, v_hi)
             WHEN 'amount_desc'       THEN -coalesce(f.total_amount, v_lo)
             ELSE                           coalesce(f.total_amount, v_hi)
           END AS sk
    FROM filtered f
  ),
  ordered AS MATERIALIZED (
    SELECT k.*, row_number() OVER (ORDER BY k.sk ASC, k.id ASC) AS rn
    FROM keyed k
    WHERE v_c_id IS NULL OR (k.sk, k.id) > (v_c_sk, v_c_id)
  ),
  -- page_size + 1 makes has_more exact: a full final page cannot emit a cursor
  -- that leads to an empty page.
  page_plus_one AS MATERIALIZED (
    SELECT o.* FROM ordered o WHERE o.rn <= v_size + 1
  ),
  page_rows AS MATERIALIZED (
    SELECT pp.* FROM page_plus_one pp WHERE pp.rn <= v_size
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
  -- Derived from the authorized selected user id + the identity resolver, NOT
  -- from a direct profiles SELECT that returns no row when the profile is gone.
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
        (SELECT count(*) FROM acted a WHERE a.user_id = p_employee_user_id),
      'actionable_expense_count',
        (SELECT count(*) FROM acted a WHERE a.user_id = p_employee_user_id
           AND (a.act->>'is_actionable')::boolean)
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
        'pending_review', s.pending_review,
        'verified', s.verified,
        'total_amount', s.total_amount,
        'scope_total', s.scope_total) FROM scope_summary s),
    'filtered_total', (SELECT filtered_total FROM tot),
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
      'schema_revision', '20260801150000')
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_queue_page_v1(uuid,integer,jsonb,text,uuid,text,text[],text[],date,date,boolean,jsonb) TO authenticated;


-- 7 ── Detail: skip soft-deleted attachments, expose actionability -------------

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
DECLARE v_out jsonb; v_ok boolean; v_ctx jsonb;
BEGIN
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);
  v_ctx := public._debug_review_caller_context_v1(p_organization_id);

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
    'employee', (SELECT jsonb_build_object(
        'user_id', i.user_id,
        'employee_name', i.employee_name,
        'employee_id', i.employee_id,
        'employee_email', i.employee_email,
        'current_balance', i.current_balance,
        'identity_source', i.identity_source,
        'identity_issue', i.identity_issue)
      FROM public._debug_review_resolve_identity_v1(p_organization_id, ARRAY[e.user_id]) i),
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
    -- Soft-deleted receipts (DOC-078) are no longer presented as live files.
    'attachments', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',a.id,'filename',a.filename,'content_type',a.content_type,
        'file_url',a.file_url,'storage_path',a.storage_path,
        'durability_status',a.durability_status))
      FROM public.attachments a
      WHERE a.expense_id = e.id AND a.deleted_at IS NULL), '[]'::jsonb),
    'deleted_attachment_count', (SELECT count(*) FROM public.attachments a
      WHERE a.expense_id = e.id AND a.deleted_at IS NOT NULL),
    'timeline', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',al.id,'action',al.action,'comment',al.comment,
        'user_id',al.user_id,'created_at',al.created_at) ORDER BY al.created_at)
      FROM public.audit_logs al WHERE al.expense_id = e.id), '[]'::jsonb),
    'corrections', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',cl.id,'edited_by',cl.edited_by,'reason',cl.reason,'created_at',cl.created_at)
        ORDER BY cl.created_at DESC)
      FROM public.expense_correction_logs cl
      WHERE cl.expense_id = e.id AND cl.organization_id = p_organization_id), '[]'::jsonb),
    'actionability', public._debug_review_actionability_v1(
        v_ctx->>'role', (v_ctx->>'caller_user_id')::uuid,
        e.status::text, e.approval_tier,
        e.assigned_reviewer_id, e.assigned_engineer_id,
        (v_ctx->>'hierarchy_enabled')::boolean,
        (v_ctx->>'team_leader_enabled')::boolean,
        (v_ctx->>'executive_enabled')::boolean,
        EXISTS (SELECT 1 FROM public._debug_review_handoff_ids_v1(p_organization_id) h
                WHERE h.expense_id = e.id))
  ) INTO v_out
  FROM public.expenses e
  WHERE e.id = p_expense_id;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_debug_review_expense_detail_v1(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_debug_review_expense_detail_v1(uuid,uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_debug_review_expense_detail_v1(uuid,uuid) TO authenticated;


-- 8 ── Capability probe reports the corrected revision -------------------------
-- Contract stays version 1: the client's required version is unchanged and the
-- response shape is a superset of the original.

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
      to_regprocedure('public._debug_review_resolve_identity_v1(uuid,uuid[])') IS NOT NULL AS identity
  )
  SELECT jsonb_build_object(
    'contract', 'debug-review-queue',
    'version', 1,
    'ready', (f.employee_search AND f.page AND f.filters AND f.detail
              AND f.actionability AND f.identity),
    'functions', jsonb_build_object(
      'employee_search', f.employee_search,
      'page', f.page,
      'filters', f.filters,
      'detail', f.detail,
      'actionability', f.actionability,
      'identity', f.identity
    ),
    'schema_revision', '20260801150000',
    'server_time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ) FROM f;
$$;

REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.debug_review_queue_capabilities_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.debug_review_queue_capabilities_v1() TO authenticated;
