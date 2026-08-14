-- Review actions (verify / reject / tier advance) bypass RLS via SECURITY DEFINER RPCs,
-- matching apply_expense_correction. Also re-apply consolidated UPDATE policies.

-- ---------------------------------------------------------------------------
-- Helper: can this user review this expense as manager (engineer tier)?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expense_manager_can_review(
  e public.expenses,
  v_uid uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'engineer'
      AND om.is_active = true
  )
  AND (
    e.assigned_engineer_id = v_uid
    OR (e.approval_tier = 'engineer' AND e.assigned_reviewer_id = v_uid)
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = e.user_id
        AND p.organization_id = e.organization_id
        AND p.reporting_engineer_id = v_uid
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Helper: can this user act at current hierarchy tier?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expense_hierarchy_reviewer_can_act(
  e public.expenses,
  v_uid uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.assigned_reviewer_id = v_uid
    AND e.approval_tier IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = v_uid
        AND om.organization_id = e.organization_id
        AND om.is_active = true
        AND (
          (om.role = 'team_leader' AND e.approval_tier = 'team_leader')
          OR (om.role = 'executive' AND e.approval_tier = 'executive')
        )
    );
$$;

-- ---------------------------------------------------------------------------
-- Team leader / executive: advance to next tier after verify
-- ---------------------------------------------------------------------------
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

  IF e.approval_tier IS NULL OR e.approval_tier NOT IN ('team_leader', 'executive') THEN
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

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Manager (engineer): verify expense -> status verified
-- ---------------------------------------------------------------------------
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

  IF e.approval_tier IN ('team_leader', 'executive') THEN
    RAISE EXCEPTION 'This expense must be verified at the current hierarchy tier first';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
  END IF;

  UPDATE public.expenses
  SET
    status = 'verified',
    updated_at = now()
  WHERE id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Reject expense (admin, manager, or hierarchy reviewer at current tier)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_reject_expense(
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
  v_can_reject boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'Approved expenses cannot be rejected';
  END IF;

  IF e.status = 'rejected' THEN
    RAISE EXCEPTION 'This expense is already rejected';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'admin'
      AND om.is_active = true
  ) INTO v_is_admin;

  v_can_reject := v_is_admin
    OR public.expense_hierarchy_reviewer_can_act(e, v_uid)
    OR public.expense_manager_can_review(e, v_uid);

  IF NOT v_can_reject THEN
    RAISE EXCEPTION 'You don''t have permission to reject this expense';
  END IF;

  UPDATE public.expenses
  SET
    status = 'rejected',
    admin_comment = nullif(trim(p_comment), ''),
    approval_tier = NULL,
    assigned_reviewer_id = NULL,
    updated_at = now()
  WHERE id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_reject_expense(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_reject_expense(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.review_advance_expense_hierarchy_tier IS
  'Team leader / executive verifies at their tier and advances workflow (SECURITY DEFINER).';
COMMENT ON FUNCTION public.review_verify_expense IS
  'Manager verifies expense to verified status (SECURITY DEFINER).';
COMMENT ON FUNCTION public.review_reject_expense IS
  'Admin, manager, or hierarchy reviewer rejects an expense (SECURITY DEFINER).';

-- ---------------------------------------------------------------------------
-- Re-apply consolidated RLS (for direct client updates / belt-and-suspenders)
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
    AND status IN ('submitted', 'edited', 'verified')
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
    AND status IN ('submitted', 'edited', 'verified', 'rejected', 'approved')
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
      OR status = 'rejected'
    )
  );

DROP POLICY IF EXISTS "Hierarchy reviewers can update assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    public.expense_hierarchy_reviewer_can_act(expenses, auth.uid())
    AND status IN ('submitted', 'edited')
  )
  WITH CHECK (
    status IN ('submitted', 'edited', 'rejected')
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
