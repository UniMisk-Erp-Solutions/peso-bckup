-- Auto-repair stuck expenses when manager verifies; broaden "ready for manager" detection.

-- Backup / old Section 3 may use RETURNS TABLE or p_org_id — drop before recreate (42P13).
DROP FUNCTION IF EXISTS public.repair_expense_for_manager_review(uuid);

CREATE OR REPLACE FUNCTION public.expense_executive_handoff_in_audit(e public.expenses)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.audit_logs al
    WHERE al.expense_id = e.id
      AND al.action = 'tier_advanced'
      AND (
        al.comment ILIKE '%advanced to engineer%'
        OR (
          al.comment ILIKE '%verified at executive%'
          AND al.comment ILIKE '%advanced to%'
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.expense_ready_for_manager_review(e public.expenses)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    e.status = 'level_2_verified'
    OR (
      COALESCE(e.approval_tier, '') = 'engineer'
      AND e.status IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified')
      AND e.status NOT IN ('verified', 'approved', 'rejected')
    )
    OR (
      e.status IN ('submitted', 'edited', 'level_1_verified')
      AND public.expense_executive_handoff_in_audit(e)
    );
$$;

CREATE OR REPLACE FUNCTION public.repair_expense_for_manager_review(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_mgr uuid;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to repair this expense for manager review';
  END IF;

  IF e.status IN ('verified', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'This expense is already past manager review';
  END IF;

  IF NOT (
    public.expense_ready_for_manager_review(e)
    OR public.expense_executive_handoff_in_audit(e)
  ) THEN
    RAISE EXCEPTION 'This expense is not ready for manager queue repair';
  END IF;

  SELECT t.manager_user_id
  INTO v_mgr
  FROM public.team_members tm
  JOIN public.teams t
    ON t.id = tm.team_id
    AND t.organization_id = tm.organization_id
  WHERE tm.user_id = e.user_id
    AND tm.organization_id = e.organization_id
  LIMIT 1;

  UPDATE public.expenses
  SET
    status = 'level_2_verified'::public.expense_status,
    approval_tier = 'engineer',
    assigned_reviewer_id = COALESCE(v_mgr, assigned_reviewer_id, v_uid),
    assigned_engineer_id = COALESCE(v_mgr, assigned_engineer_id, v_uid),
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object('ok', true, 'expense', v_after);
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
  v_mgr uuid;
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

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
  END IF;

  IF e.status NOT IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified') THEN
    RAISE EXCEPTION 'Only submitted, adjusted, or hierarchy-verified expenses can be verified by a manager';
  END IF;

  IF e.approval_tier IN ('team_leader', 'executive')
    AND NOT public.expense_executive_handoff_in_audit(e) THEN
    RAISE EXCEPTION 'This expense must be verified by the team leader or executive before manager verification';
  END IF;

  IF public.expense_ready_for_manager_review(e)
    OR public.expense_executive_handoff_in_audit(e) THEN
  SELECT t.manager_user_id
  INTO v_mgr
  FROM public.team_members tm
  JOIN public.teams t
    ON t.id = tm.team_id
    AND t.organization_id = tm.organization_id
  WHERE tm.user_id = e.user_id
    AND tm.organization_id = e.organization_id
  LIMIT 1;

    IF e.status <> 'level_2_verified'::public.expense_status
      OR COALESCE(e.approval_tier, '') <> 'engineer' THEN
      UPDATE public.expenses
      SET
        status = 'level_2_verified'::public.expense_status,
        approval_tier = 'engineer',
        assigned_reviewer_id = COALESCE(v_mgr, assigned_reviewer_id, v_uid),
        assigned_engineer_id = COALESCE(v_mgr, assigned_engineer_id, v_uid),
        updated_at = now()
      WHERE id = p_expense_id;

      SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'This expense is not at the manager review step';
  END IF;

  UPDATE public.expenses
  SET
    status = 'verified',
    approval_tier = COALESCE(e.approval_tier, 'engineer'),
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

DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);

CREATE OR REPLACE FUNCTION public.list_manager_pending_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND (
      public.expense_ready_for_manager_review(e)
      OR public.expense_executive_handoff_in_audit(e)
    )
    AND public.manager_expense_visible_to_user(e, auth.uid())
    AND e.status NOT IN ('verified', 'approved', 'rejected')
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    );
$$;

REVOKE ALL ON FUNCTION public.expense_executive_handoff_in_audit(public.expenses) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_executive_handoff_in_audit(public.expenses) TO authenticated;

REVOKE ALL ON FUNCTION public.repair_expense_for_manager_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repair_expense_for_manager_review(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;

-- One-time repair for orgs that already ran 24320000 without audit-based rows.
UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  updated_at = now()
WHERE public.expense_executive_handoff_in_audit(e)
  AND e.status IN (
    'submitted'::public.expense_status,
    'edited'::public.expense_status,
    'level_1_verified'::public.expense_status
  );
