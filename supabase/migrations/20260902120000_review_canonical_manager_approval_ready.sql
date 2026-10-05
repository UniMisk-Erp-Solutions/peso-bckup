-- DOC-113 — one canonical normal-Manager approval decision for preview + mutation.
--
-- Production forensic result (2026-09-02): review_approve_expense accepted an
-- engineer-role Manager through expense_manager_can_review's reporting-chain
-- visibility, while review_preview_approval_targets_v1 rejected the same caller
-- because _debug_review_actionability_v1 only knew the persisted assignment
-- UUIDs. Older already-verified rows still name the immediate Executive in
-- assigned_*; those fields are routing provenance, not sufficient authority for
-- the final Manager decision. No expense metadata is rewritten here.

BEGIN;

CREATE OR REPLACE FUNCTION public._review_manager_normal_approval_ready_v1(
  e public.expenses,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = p_user_id
        AND om.organization_id = e.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND public.manager_expense_visible_to_user(e, p_user_id)
    AND CASE
      WHEN public.org_feature_enabled(e.organization_id, 'approval_hierarchy') THEN
        coalesce(e.approval_tier NOT IN ('team_leader', 'executive'), true)
        AND e.status::text IN ('submitted', 'edited', 'level_2_verified')
      ELSE e.status::text IN ('submitted', 'edited')
    END;
$$;

REVOKE ALL ON FUNCTION public._review_manager_normal_approval_ready_v1(public.expenses, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._review_manager_normal_approval_ready_v1(public.expenses, uuid) FROM anon;
REVOKE ALL ON FUNCTION public._review_manager_normal_approval_ready_v1(public.expenses, uuid) FROM authenticated;

COMMENT ON FUNCTION public._review_manager_normal_approval_ready_v1(public.expenses, uuid) IS
  'Internal canonical boolean shared by normal Manager approval preview and mutation. '
  'Requires active engineer-role membership in the expense organization, canonical '
  'manager/reporting-chain visibility, and the same workflow-stage readiness enforced '
  'by review_approve_expense. The amount ceiling remains a separate classification.';

CREATE OR REPLACE FUNCTION public.review_approve_expense(
  p_expense_id uuid,
  p_comment text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_is_admin boolean := false;
  v_is_engineer boolean := false;
  v_hierarchy boolean := false;
  v_limit numeric;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'admin'
      AND om.is_active = true
  ) INTO v_is_admin;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'engineer'
      AND om.is_active = true
  ) INTO v_is_engineer;

  IF NOT v_is_admin AND NOT v_is_engineer THEN
    RAISE EXCEPTION 'Only managers or administrators can approve expenses';
  END IF;

  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'This expense is already approved';
  END IF;

  SELECT public.org_feature_enabled(e.organization_id, 'approval_hierarchy')
  INTO v_hierarchy;

  IF v_is_admin THEN
    IF e.status NOT IN (
      'submitted', 'edited', 'verified', 'level_1_verified', 'level_2_verified'
    ) THEN
      RAISE EXCEPTION 'Admins can only approve submitted, verified, adjusted, or hierarchy-verified expenses';
    END IF;

    IF e.status IN ('submitted', 'edited') THEN
      UPDATE public.expenses
      SET status = 'verified', updated_at = now()
      WHERE id = p_expense_id;
      SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
    END IF;
  ELSE
    -- This helper is the decision. The branches below only preserve the
    -- existing user-facing error specificity when the canonical gate is false.
    IF NOT public._review_manager_normal_approval_ready_v1(e, v_uid) THEN
      IF v_hierarchy AND e.approval_tier IN ('team_leader', 'executive') THEN
        RAISE EXCEPTION 'This expense must be verified by the team leader or executive before approval';
      ELSIF v_hierarchy AND e.status NOT IN ('submitted', 'edited', 'level_2_verified') THEN
        RAISE EXCEPTION 'Managers can only approve submitted, adjusted, or Level 2 verified expenses';
      ELSIF NOT v_hierarchy AND e.status NOT IN ('submitted', 'edited') THEN
        RAISE EXCEPTION 'Engineers can only approve submitted or adjusted expenses';
      ELSE
        RAISE EXCEPTION 'You don''t have permission to review this expense';
      END IF;
    END IF;

    SELECT os.engineer_approval_limit
    INTO v_limit
    FROM public.organization_settings os
    WHERE os.organization_id = e.organization_id
    LIMIT 1;

    IF v_limit IS NOT NULL AND v_limit > 0 AND e.total_amount > v_limit THEN
      RAISE EXCEPTION
        'This expense exceeds the manager approval limit. Please verify instead.';
    END IF;
  END IF;

  UPDATE public.expenses
  SET
    status = 'approved',
    admin_comment = COALESCE(nullif(trim(p_comment), ''), admin_comment),
    approved_by = v_uid,
    approved_at = now(),
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), ''),
    'auto_verified', v_is_admin AND e.status = 'verified'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.review_approve_expense(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_approve_expense(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_approve_expense(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_preview_approval_targets_v1(
  p_organization_id uuid,
  p_expense_ids uuid[]
)
RETURNS TABLE (
  expense_id uuid,
  transaction_number text,
  batch_id uuid,
  employee_user_id uuid,
  employee_id text,
  employee_name text,
  amount numeric,
  status text,
  approval_tier text,
  is_actionable boolean,
  actionable_stage text,
  actionable_reason text,
  available_actions jsonb,
  is_terminal boolean,
  in_assigned_scope boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_ctx jsonb;
BEGIN
  IF p_expense_ids IS NULL OR array_length(p_expense_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_expense_ids must be a non-empty array';
  END IF;
  IF array_length(p_expense_ids, 1) > 1000 THEN
    RAISE EXCEPTION 'Too many expenses in one preview request (max 1000)';
  END IF;

  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);
  v_ctx := public._debug_review_caller_context_v1(p_organization_id);

  RETURN QUERY
  WITH handoff AS (
    SELECT h.expense_id FROM public._debug_review_handoff_ids_v1(p_organization_id) h
  ),
  scope AS (
    SELECT s.expense_id FROM public._debug_review_assigned_scope_v1(p_organization_id) s
  ),
  target AS (
    SELECT e.id, e.transaction_number, e.batch_id, e.user_id, e.total_amount,
           e.status::text AS status, e.approval_tier,
           public._debug_review_actionability_v1(
             v_ctx->>'role', (v_ctx->>'caller_user_id')::uuid,
             e.status::text, e.approval_tier,
             e.assigned_reviewer_id, e.assigned_engineer_id,
             (v_ctx->>'hierarchy_enabled')::boolean,
             (v_ctx->>'team_leader_enabled')::boolean,
             (v_ctx->>'executive_enabled')::boolean,
             EXISTS (SELECT 1 FROM handoff h WHERE h.expense_id = e.id)
           ) AS act,
           public._review_manager_normal_approval_ready_v1(
             e, (v_ctx->>'caller_user_id')::uuid
           ) AS manager_normal_ready
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.id = ANY(p_expense_ids)
  )
  SELECT
    t.id,
    t.transaction_number,
    t.batch_id,
    t.user_id,
    p.employee_id,
    p.name,
    t.total_amount,
    t.status,
    t.approval_tier,
    CASE WHEN t.manager_normal_ready THEN true ELSE (t.act->>'is_actionable')::boolean END,
    CASE WHEN t.manager_normal_ready THEN 'engineer' ELSE t.act->>'actionable_stage' END,
    CASE WHEN t.manager_normal_ready THEN 'manager_normal_approval_ready' ELSE t.act->>'actionable_reason' END,
    CASE WHEN t.manager_normal_ready THEN '["approve","reject","correct"]'::jsonb ELSE t.act->'available_actions' END,
    t.status IN ('verified', 'approved', 'rejected'),
    EXISTS (SELECT 1 FROM scope sc WHERE sc.expense_id = t.id)
  FROM target t
  LEFT JOIN public.profiles p
    ON p.user_id = t.user_id AND p.organization_id = p_organization_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.review_preview_approval_targets_v1(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_preview_approval_targets_v1(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_preview_approval_targets_v1(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.review_preview_approval_targets_v1(uuid, uuid[]) IS
  'Read-only approval preview. Normal Manager approval delegates to the same '
  '_review_manager_normal_approval_ready_v1 helper used by review_approve_expense; '
  'other reviewer actions retain _debug_review_actionability_v1 semantics.';

NOTIFY pgrst, 'reload schema';

COMMIT;
