-- Fix TL verify: allow advance when approval_tier is NULL (legacy assignment) and expose review head for routing.

CREATE OR REPLACE FUNCTION public.get_expense_review_head(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT (
    public.reviewer_can_act_on_expense(p_expense_id)
    OR e.user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  ) THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', e.id,
    'organization_id', e.organization_id,
    'status', e.status,
    'approval_tier', e.approval_tier,
    'assigned_reviewer_id', e.assigned_reviewer_id,
    'assigned_engineer_id', e.assigned_engineer_id,
    'user_id', e.user_id,
    'title', e.title,
    'total_amount', e.total_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_expense_review_head(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expense_review_head(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_advance_expense_hierarchy_tier(
  p_expense_id uuid,
  p_next_approval_tier text,
  p_next_assigned_reviewer_id uuid DEFAULT NULL,
  p_next_assigned_engineer_id uuid DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at this tier';
  END IF;

  IF e.approval_tier IS NOT NULL AND e.approval_tier NOT IN ('team_leader', 'executive') THEN
    RAISE EXCEPTION 'This expense is not awaiting hierarchy tier verification';
  END IF;

  IF NOT public.expense_hierarchy_reviewer_can_act(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to verify this expense at the current tier';
  END IF;

  IF p_next_approval_tier NOT IN ('team_leader', 'executive', 'engineer', 'admin') THEN
    RAISE EXCEPTION 'Invalid next approval tier';
  END IF;

  UPDATE public.expenses
  SET
    approval_tier = p_next_approval_tier,
    assigned_reviewer_id = CASE
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_reviewer_id
    END,
    assigned_engineer_id = CASE
      WHEN p_next_approval_tier = 'engineer' THEN COALESCE(p_next_assigned_engineer_id, p_next_assigned_reviewer_id)
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_engineer_id
    END,
    status = 'submitted',
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.review_verify_expense(
  p_expense_id uuid,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'This expense is already approved and cannot be updated';
  END IF;

  IF e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified';
  END IF;

  IF e.approval_tier IN ('team_leader', 'executive')
    OR (
      e.approval_tier IS NULL
      AND public.expense_hierarchy_reviewer_can_act(e, v_uid)
    ) THEN
    RAISE EXCEPTION 'Use Verify on this screen to complete the team leader or executive step first (not manager verify)';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
  END IF;

  UPDATE public.expenses
  SET
    status = 'verified',
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;
