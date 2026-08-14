-- Managers never saw Level 2 because status stayed "submitted" after executive verify (old RPC).
-- This migration: backfill stuck rows + RPC for manager actionable queue (incl. mislabeled statuses).

-- Restore/backup may have p_org_id — must drop before CREATE OR REPLACE (42P13).
DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);
DROP FUNCTION IF EXISTS public.list_manager_level2_expenses(uuid);

CREATE OR REPLACE FUNCTION public.manager_expense_visible_to_user(
  e public.expenses,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.assigned_engineer_id = p_user_id
    OR e.assigned_reviewer_id = p_user_id
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = e.user_id
        AND p.organization_id = e.organization_id
        AND p.reporting_engineer_id = p_user_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      JOIN public.teams t
        ON t.id = tm.team_id
        AND t.organization_id = tm.organization_id
      WHERE tm.user_id = e.user_id
        AND tm.organization_id = e.organization_id
        AND t.manager_user_id = p_user_id
    );
$$;

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
  AND public.manager_expense_visible_to_user(e, v_uid);
$$;

CREATE OR REPLACE FUNCTION public.expense_ready_for_manager_review(e public.expenses)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    e.status = 'level_2_verified'
    OR (
      COALESCE(e.approval_tier, '') = 'engineer'
      AND e.status IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified')
    )
    OR (
      e.status = 'level_1_verified'
      AND COALESCE(e.approval_tier, '') = 'engineer'
    );
$$;

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
    AND public.expense_ready_for_manager_review(e)
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

CREATE OR REPLACE FUNCTION public.list_manager_level2_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND public.expense_ready_for_manager_review(e)
    AND public.manager_expense_visible_to_user(e, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    );
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

  IF e.status NOT IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified') THEN
    RAISE EXCEPTION 'Only submitted, adjusted, or hierarchy-verified expenses can be verified by a manager';
  END IF;

  IF e.approval_tier IN ('team_leader', 'executive') THEN
    RAISE EXCEPTION 'This expense must be verified by the team leader or executive before manager verification';
  END IF;

  IF COALESCE(e.approval_tier, '') NOT IN ('engineer', '')
    AND e.status NOT IN ('level_2_verified') THEN
    RAISE EXCEPTION 'This expense is not at the manager review step';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
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

REVOKE ALL ON FUNCTION public.expense_manager_can_review(public.expenses, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_manager_can_review(public.expenses, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.manager_expense_visible_to_user(public.expenses, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manager_expense_visible_to_user(public.expenses, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.list_manager_pending_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_pending_expenses(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;

-- Backfill: executive already advanced (engineer tier) but status never updated.
UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  updated_at = now()
WHERE COALESCE(e.approval_tier, '') = 'engineer'
  AND e.status IN (
    'submitted'::public.expense_status,
    'edited'::public.expense_status,
    'level_1_verified'::public.expense_status
  );

UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  updated_at = now()
FROM public.audit_logs al
WHERE al.expense_id = e.id
  AND al.action = 'tier_advanced'
  AND al.comment ILIKE '%executive%'
  AND e.status IN (
    'submitted'::public.expense_status,
    'edited'::public.expense_status,
    'level_1_verified'::public.expense_status
  );

-- Ensure manager assignment on all level_2 / engineer-tier queue rows.
UPDATE public.expenses e
SET
  approval_tier = 'engineer',
  assigned_reviewer_id = t.manager_user_id,
  assigned_engineer_id = t.manager_user_id,
  updated_at = now()
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND (
    e.status = 'level_2_verified'::public.expense_status
    OR COALESCE(e.approval_tier, '') = 'engineer'
  )
  AND e.status NOT IN ('verified', 'approved', 'rejected');
