-- Team leader verify: allow mis-tiered rows (approval_tier=engineer but TL is assignee) and backfill.

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
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.is_active = true
      AND (
        (
          om.role = 'team_leader'
          AND (
            e.approval_tier IS NULL
            OR e.approval_tier IN ('team_leader', 'engineer')
          )
        )
        OR (
          om.role = 'executive'
          AND (
            e.approval_tier IS NULL
            OR e.approval_tier IN ('executive', 'engineer')
          )
        )
      )
  )
  AND (
    e.assigned_reviewer_id = v_uid
    OR e.assigned_engineer_id = v_uid
  );
$$;

-- Mis-routed: engineer tier but assignee is actually a team leader / executive.
UPDATE public.expenses e
SET
  approval_tier = 'team_leader',
  assigned_reviewer_id = COALESCE(e.assigned_reviewer_id, e.assigned_engineer_id)
WHERE e.approval_tier = 'engineer'
  AND e.assigned_engineer_id IS NOT NULL
  AND e.status IN ('submitted', 'edited', 'under_review')
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = e.assigned_engineer_id
      AND om.organization_id = e.organization_id
      AND om.role = 'team_leader'
      AND om.is_active = true
  );

UPDATE public.expenses e
SET
  approval_tier = 'executive',
  assigned_reviewer_id = COALESCE(e.assigned_reviewer_id, e.assigned_engineer_id)
WHERE e.approval_tier = 'engineer'
  AND e.assigned_engineer_id IS NOT NULL
  AND e.status IN ('submitted', 'edited', 'under_review')
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = e.assigned_engineer_id
      AND om.organization_id = e.organization_id
      AND om.role = 'executive'
      AND om.is_active = true
  );

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
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
    OR (
      (e.assigned_reviewer_id = auth.uid() OR e.assigned_engineer_id = auth.uid())
      AND EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        WHERE om.user_id = auth.uid()
          AND om.organization_id = e.organization_id
          AND om.role IN ('team_leader', 'executive')
          AND om.is_active = true
      )
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

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;
