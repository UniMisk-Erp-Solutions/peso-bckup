-- Managers (engineers) keep visibility while expenses move through TL/executive tiers.
-- list_manager_reviewer_expenses mirrors hierarchy RPC for reliable review queues.

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
      ELSE COALESCE(p_next_assigned_engineer_id, e.assigned_engineer_id)
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

CREATE OR REPLACE FUNCTION public.list_manager_reviewer_expenses(p_organization_id uuid)
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
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR (
        e.approval_tier = 'engineer'
        AND (
          e.assigned_reviewer_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
    );
$$;

REVOKE ALL ON FUNCTION public.list_manager_reviewer_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_reviewer_expenses(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_manager_reviewer_expenses(uuid) IS
  'Returns expenses visible to the signed-in manager (engineer) for review, including hierarchy pipeline rows.';

-- Backfill: restore managing engineer on in-flight hierarchy expenses.
UPDATE public.expenses e
SET assigned_engineer_id = t.manager_user_id
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status IN (
    'submitted',
    'edited',
    'level_1_verified',
    'level_2_verified',
    'under_review'
  )
  AND (
    e.approval_tier IN ('team_leader', 'executive')
    OR (e.status = 'level_2_verified' AND COALESCE(e.approval_tier, '') <> 'engineer')
    OR (e.status = 'level_1_verified' AND e.approval_tier = 'engineer')
  )
  AND (e.assigned_engineer_id IS DISTINCT FROM t.manager_user_id);

-- Route level_2_verified rows to manager when executive step is done.
UPDATE public.expenses e
SET
  approval_tier = 'engineer',
  assigned_reviewer_id = t.manager_user_id,
  assigned_engineer_id = t.manager_user_id
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status = 'level_2_verified'::public.expense_status
  AND COALESCE(e.approval_tier, '') <> 'engineer';
