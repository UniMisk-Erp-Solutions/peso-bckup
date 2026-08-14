-- Admin / manager approve + admin verify via SECURITY DEFINER RPCs (avoids RLS 403 on batch review).
-- Re-assert org-admin UPDATE policy on expenses for direct client paths (belt-and-suspenders).

-- ---------------------------------------------------------------------------
-- 1) Org admin verify (batch review "Verify" as admin)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_admin_verify_expense(
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'admin'
      AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Only organization administrators can verify expenses this way';
  END IF;

  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'This expense is already approved and cannot be updated';
  END IF;

  IF e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified';
  END IF;

  UPDATE public.expenses
  SET
    status = 'verified',
    admin_comment = COALESCE(nullif(trim(p_comment), ''), admin_comment),
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

-- ---------------------------------------------------------------------------
-- 2) Approve expense (admin bypasses hierarchy; manager follows policy)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_approve_expense(
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

  SELECT COALESCE(
    (
      SELECT ofe.enabled
      FROM public.organization_features ofe
      WHERE ofe.organization_id = e.organization_id
        AND ofe.feature_key = 'approval_hierarchy'
    ),
    false
  ) INTO v_hierarchy;

  IF v_is_admin THEN
    IF e.status NOT IN (
      'submitted', 'edited', 'verified', 'level_1_verified', 'level_2_verified'
    ) THEN
      RAISE EXCEPTION 'Admins can only approve submitted, verified, adjusted, or hierarchy-verified expenses';
    END IF;

    -- Auto-verify submitted/adjusted before final approval (admin override).
    IF e.status IN ('submitted', 'edited') THEN
      UPDATE public.expenses
      SET status = 'verified', updated_at = now()
      WHERE id = p_expense_id;
      SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
    END IF;
  ELSE
    -- Manager path
    IF v_hierarchy THEN
      IF e.approval_tier IN ('team_leader', 'executive') THEN
        RAISE EXCEPTION 'This expense must be verified by the team leader or executive before approval';
      END IF;

      IF e.status NOT IN ('submitted', 'edited', 'level_2_verified') THEN
        RAISE EXCEPTION 'Managers can only approve submitted, adjusted, or Level 2 verified expenses';
      END IF;
    ELSE
      IF e.status NOT IN ('submitted', 'edited') THEN
        RAISE EXCEPTION 'Engineers can only approve submitted or adjusted expenses';
      END IF;
    END IF;

    IF NOT public.expense_manager_can_review(e, v_uid) THEN
      RAISE EXCEPTION 'You don''t have permission to review this expense';
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
$$;

REVOKE ALL ON FUNCTION public.review_admin_verify_expense(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_approve_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_admin_verify_expense(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_approve_expense(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.review_admin_verify_expense(uuid, text) IS
  'Org admin verifies expense to verified status; bypasses hierarchy tier (SECURITY DEFINER).';
COMMENT ON FUNCTION public.review_approve_expense(uuid, text) IS
  'Admin or manager approves expense; admin bypasses hierarchy tiers (SECURITY DEFINER).';

-- ---------------------------------------------------------------------------
-- 3) Belt-and-suspenders: org admins can UPDATE any expense in their org
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can update any expense" ON public.expenses;
CREATE POLICY "Admins can update any expense"
  ON public.expenses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
    AND organization_id IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 4) Engineers: allow UPDATE when approving hierarchy-verified rows
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Engineers can update assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND status IN ('submitted', 'edited', 'verified', 'level_1_verified', 'level_2_verified')
    AND (
      expenses.assigned_engineer_id = auth.uid()
      OR (expenses.approval_tier = 'engineer' AND expenses.assigned_reviewer_id = auth.uid())
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = expenses.user_id
          AND p.organization_id = expenses.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR public.expense_manager_can_review(expenses, auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND status IN ('submitted', 'edited', 'verified', 'level_1_verified', 'level_2_verified', 'rejected', 'approved')
    AND (
      expenses.assigned_engineer_id = auth.uid()
      OR (expenses.approval_tier = 'engineer' AND expenses.assigned_reviewer_id = auth.uid())
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = expenses.user_id
          AND p.organization_id = expenses.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR public.expense_manager_can_review(expenses, auth.uid())
      OR status IN ('rejected', 'approved')
    )
  );

NOTIFY pgrst, 'reload schema';
