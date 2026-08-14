-- Part 2/2: Functions and RLS using level_1_verified / level_2_verified (run after 20260524250000).

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
  v_new_status public.expense_status;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.approval_tier = 'team_leader' AND e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at team leader tier';
  END IF;

  IF e.approval_tier = 'executive' AND e.status NOT IN ('submitted', 'edited', 'level_1_verified') THEN
    RAISE EXCEPTION 'Only expenses awaiting executive review can be verified at this tier';
  END IF;

  IF e.approval_tier IS NULL AND e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at this tier';
  END IF;

  IF e.approval_tier IS NOT NULL
    AND e.approval_tier NOT IN ('team_leader', 'executive', 'engineer') THEN
    RAISE EXCEPTION 'This expense is not awaiting hierarchy tier verification';
  END IF;

  IF NOT public.expense_hierarchy_reviewer_can_act(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to verify this expense at the current tier';
  END IF;

  IF p_next_approval_tier NOT IN ('team_leader', 'executive', 'engineer', 'admin') THEN
    RAISE EXCEPTION 'Invalid next approval tier';
  END IF;

  v_new_status := CASE
    WHEN e.approval_tier = 'team_leader' THEN 'level_1_verified'::public.expense_status
    WHEN e.approval_tier = 'executive' THEN 'level_2_verified'::public.expense_status
    WHEN e.approval_tier IS NULL AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = v_uid AND om.organization_id = e.organization_id
        AND om.role = 'team_leader' AND om.is_active = true
    ) THEN 'level_1_verified'::public.expense_status
    WHEN e.approval_tier IS NULL AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = v_uid AND om.organization_id = e.organization_id
        AND om.role = 'executive' AND om.is_active = true
    ) THEN 'level_2_verified'::public.expense_status
    ELSE e.status
  END;

  UPDATE public.expenses
  SET
    status = v_new_status,
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

CREATE OR REPLACE FUNCTION public.list_hierarchy_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review',
      'level_1_verified',
      'level_2_verified'
    )
    AND (
      e.assigned_reviewer_id = auth.uid()
      OR e.assigned_engineer_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role IN ('team_leader', 'executive')
    );
$$;

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;

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

  IF e.status NOT IN ('submitted', 'edited', 'level_2_verified') THEN
    RAISE EXCEPTION 'Only submitted, adjusted, or level 2 verified expenses can be verified by a manager';
  END IF;

  IF e.approval_tier IN ('team_leader', 'executive')
    OR (
      e.approval_tier IS NULL
      AND public.expense_hierarchy_reviewer_can_act(e, v_uid)
    ) THEN
    RAISE EXCEPTION 'This expense must be verified by the team leader or executive before manager verification';
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

REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;

DROP POLICY IF EXISTS "Hierarchy reviewers can update assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    (auth.uid() = assigned_reviewer_id OR auth.uid() = assigned_engineer_id)
    AND (
      (
        approval_tier = 'team_leader'
        AND status IN ('submitted', 'edited')
      )
      OR (
        approval_tier = 'executive'
        AND status IN ('submitted', 'edited', 'level_1_verified')
      )
      OR (
        approval_tier IS NULL
        AND status IN ('submitted', 'edited', 'level_1_verified')
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND (
          (om.role = 'team_leader' AND (expenses.approval_tier IS NULL OR expenses.approval_tier = 'team_leader'))
          OR (om.role = 'executive' AND (expenses.approval_tier IS NULL OR expenses.approval_tier = 'executive'))
        )
    )
  )
  WITH CHECK (
    status IN ('submitted', 'edited', 'rejected', 'level_1_verified', 'level_2_verified')
    AND status <> 'approved'
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND om.role IN ('team_leader', 'executive')
    )
  );
