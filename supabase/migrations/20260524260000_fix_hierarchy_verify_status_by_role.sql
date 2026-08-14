-- TL verify was leaving status as "submitted" when approval_tier was "engineer" (legacy rows)
-- or when an older review_advance_expense_hierarchy_tier still forced status = 'submitted'.
-- Set status from the verifying user's role (team_leader → level_1_verified, executive → level_2_verified).

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
  v_is_tl boolean;
  v_is_exec boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
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

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'team_leader'
      AND om.is_active = true
  ) INTO v_is_tl;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'executive'
      AND om.is_active = true
  ) INTO v_is_exec;

  IF v_is_tl THEN
    IF e.status NOT IN ('submitted', 'edited') THEN
      RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at team leader tier';
    END IF;
    v_new_status := 'level_1_verified'::public.expense_status;
  ELSIF v_is_exec THEN
    IF e.status NOT IN ('submitted', 'edited', 'level_1_verified') THEN
      RAISE EXCEPTION 'Only expenses awaiting executive review can be verified at this tier';
    END IF;
    v_new_status := 'level_2_verified'::public.expense_status;
  ELSE
    RAISE EXCEPTION 'Only team leaders and executives can verify at hierarchy tiers';
  END IF;

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

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;
