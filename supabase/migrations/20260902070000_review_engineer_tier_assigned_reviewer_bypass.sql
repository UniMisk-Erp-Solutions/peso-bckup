-- Review Expenses hotfix: a genuinely fully-verified expense at the final
-- ("engineer" tier) was misclassified as "waiting for previous verification"
-- and offered only Manager Override, even though it correctly completed
-- every required hierarchy verification tier.
--
-- ROOT CAUSE (proven live, read-only, against Production):
-- `review_advance_expense_hierarchy_tier` can legitimately assign a caller
-- whose organization role is NOT literally 'engineer' as an expense's final
-- ("engineer" tier) reviewer -- specifically when an employee's
-- `reporting_engineer_id` points directly at a person whose org role is
-- 'executive' (no dedicated role='engineer' manager exists in that
-- employee's chain). That routing decision is intentional and already
-- happens today: `review_verify_batch_atomic_v1` explicitly resolves this
-- case ("WHEN v_reporting_supervisor_role = 'executive' THEN
-- v_reporting_engineer_id"), and correctly writes
-- assigned_reviewer_id = assigned_engineer_id = that executive, with
-- approval_tier = 'engineer'.
--
-- But the three functions that GATE whether that same caller may then act
-- all hard-require the caller's raw organization role to literally equal
-- 'engineer' (or 'admin'), with no exception for "the hierarchy engine
-- specifically assigned you as this expense's final reviewer":
--   - expense_manager_can_review(e, v_uid)
--   - review_approve_expense(...)'s initial v_is_engineer gate
--   - _debug_review_actionability_v1(...)'s v_can_act (which
--     get_debug_review_queue_page_v1 / review_preview_approval_targets_v1
--     call directly, so this is what the Review queue and the Bulk Approve
--     dialog both actually see -- this is a genuine SERVER-side bug, not a
--     frontend mapping or stale-cache issue)
--
-- Proven live via _debug_review_actionability_v1 with the real affected
-- expense's real parameters (role='executive', tier='engineer',
-- status='level_2_verified', assigned_reviewer_id = assigned_engineer_id =
-- caller): returned is_actionable=false, actionable_reason=
-- 'role_cannot_act_at_engineer', available_actions=[] -- exactly matching
-- the reported "Waiting for previous verification" / Manager-Override-only
-- dialog seen on the affected batch.
--
-- Scope (read-only production query, not hardcoded into this fix): a
-- meaningful number of expenses across more than one organization are
-- affected the same way; no employee ID, organization ID, or role name is
-- hardcoded in the fix below -- it trusts whatever the hierarchy engine
-- already wrote to assigned_engineer_id/approval_tier for ANY expense, in
-- any organization.
--
-- FIX: a caller who is literally `assigned_engineer_id` for an expense
-- currently at `approval_tier = 'engineer'` (the terminal, pre-manager-
-- approval tier) is trusted as that expense's assigned final reviewer,
-- regardless of their raw organization role string. This does not grant any
-- broader permission -- it only unlocks the ONE specific expense the
-- hierarchy engine already, deliberately assigned to this exact caller.
-- Team-leader/executive verification at THEIR OWN tier (approval_tier =
-- 'team_leader'/'executive') is completely unaffected; visibility
-- (manager_expense_visible_to_user) and the approval-limit/status checks in
-- review_approve_expense are unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.expense_manager_can_review(e expenses, v_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = v_uid
        AND om.organization_id = e.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    -- Trust the hierarchy engine's own final-tier assignment even when the
    -- caller's raw org role isn't literally 'engineer' (e.g. an executive
    -- who is an employee's only manager, per review_verify_batch_atomic_v1's
    -- reporting-chain fallback).
    OR (e.approval_tier = 'engineer' AND e.assigned_engineer_id = v_uid)
  )
  AND public.manager_expense_visible_to_user(e, v_uid);
$function$;

CREATE OR REPLACE FUNCTION public.review_approve_expense(p_expense_id uuid, p_comment text DEFAULT NULL::text)
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

  -- Same reasoning as expense_manager_can_review above: a caller who is
  -- literally the expense's assigned_engineer_id at the terminal 'engineer'
  -- tier is trusted as this expense's manager, regardless of their raw org
  -- role string.
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'engineer'
      AND om.is_active = true
  ) OR (e.approval_tier = 'engineer' AND e.assigned_engineer_id = v_uid)
  INTO v_is_engineer;

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
$function$;

CREATE OR REPLACE FUNCTION public._debug_review_actionability_v1(p_role text, p_caller uuid, p_status text, p_tier text, p_assigned_reviewer uuid, p_assigned_engineer uuid, p_hierarchy_enabled boolean, p_team_leader_enabled boolean, p_executive_enabled boolean, p_handoff boolean)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  -- MANAGER_ACTIONABLE_STATUSES, verbatim from managerActionableExpenses.ts
  v_open_statuses text[] := ARRAY['submitted','edited','under_review',
                                  'level_1_verified','level_2_verified'];
  -- ADMIN_APPROVABLE_STATUSES (approvalHierarchy.ts), non-terminal-for-admin set.
  -- 'verified' is INCLUDED: review_approve_expense's `IF v_is_admin` branch and
  -- isAdminApprovableStatus both allow it, and the balance is not yet deducted.
  v_admin_open    text[] := ARRAY['submitted','edited','verified',
                                  'level_1_verified','level_2_verified'];
  -- v_terminal still includes 'verified' so NON-admin callers keep the terminal
  -- (view-only) treatment on it. The admin fast-path below runs first and only
  -- for admins, so it is the sole path that makes 'verified' actionable.
  v_terminal      boolean := p_status IN ('verified','approved','rejected');
  v_is_reviewer   boolean := p_assigned_reviewer IS NOT NULL AND p_assigned_reviewer = p_caller;
  v_is_engineer   boolean := p_assigned_engineer IS NOT NULL AND p_assigned_engineer = p_caller;
  v_open          boolean := p_status = ANY(v_open_statuses);
  v_can_verify    boolean;
  v_can_act       boolean;
  v_queue_ready   boolean;
  v_skipped       boolean;
  v_actionable    boolean;
  v_stage         text;
  v_reason        text;
  v_actions       jsonb;
  -- The hierarchy engine (review_advance_expense_hierarchy_tier) can assign a
  -- caller whose org role is not literally 'engineer' as an expense's final
  -- reviewer (e.g. an executive who is an employee's only manager). Trust
  -- that specific, system-made assignment at the terminal 'engineer' tier
  -- regardless of the caller's raw role string -- this is the exact gap that
  -- caused a genuinely fully-verified expense to be misclassified as
  -- "waiting for previous verification".
  v_assigned_final_reviewer boolean := p_tier = 'engineer' AND p_assigned_engineer IS NOT NULL AND p_assigned_engineer = p_caller;
BEGIN
  -- Org-admin super-approver FIRST, before the terminal gate, so 'verified'
  -- (terminal for everyone else) is offered to admins. Mirrors
  -- review_approve_expense's `IF v_is_admin` branch (skips hierarchy tier +
  -- direct-assignment gates). Self-owned rows never reach here -- the assigned
  -- scope helper excludes them, and the client re-checks isSelfOwned.
  IF p_role = 'admin' AND p_status = ANY(v_admin_open) THEN
    RETURN jsonb_build_object(
      'is_actionable', true,
      'actionable_stage', coalesce(p_tier, 'admin'),
      'actionable_reason', 'admin_approvable',
      'available_actions', '["approve","reject","correct"]'::jsonb,
      'view_only', false);
  END IF;

  IF v_terminal THEN
    RETURN jsonb_build_object(
      'is_actionable', false,
      'actionable_stage', 'terminal',
      'actionable_reason', 'status_' || p_status,
      'available_actions', '[]'::jsonb,
      'view_only', true);
  END IF;

  -- canRoleVerifyAtTier(role, tier)
  v_can_verify := CASE
    WHEN p_tier IS NULL          THEN p_role IN ('engineer','admin')
    WHEN p_tier = 'team_leader'  THEN p_role = 'team_leader'
    WHEN p_tier = 'executive'    THEN p_role = 'executive'
    WHEN p_tier = 'engineer'     THEN p_role = 'engineer'
    ELSE p_role = 'admin'
  END;

  -- canRoleActOnExpense(role, tier, assignedReviewerId, userId, assignedEngineerId)
  v_can_act := CASE
    WHEN p_role = 'admin' AND p_tier = 'admin' THEN true
    WHEN v_assigned_final_reviewer THEN true
    WHEN NOT (v_is_reviewer OR v_is_engineer)  THEN false
    WHEN p_tier IS NULL THEN p_role IN ('team_leader','executive') AND v_is_engineer
    WHEN v_is_reviewer AND v_can_verify THEN true
    WHEN v_is_engineer AND (
           v_can_verify
        OR (p_role = 'team_leader' AND p_tier = 'team_leader')
        OR (p_role = 'executive'   AND p_tier = 'executive')
    ) THEN true
    ELSE false
  END;

  -- isSkippedHierarchyTier(): routing skipped this tier because it is disabled.
  v_skipped := p_hierarchy_enabled AND p_tier IS NOT NULL AND (
       (p_tier = 'team_leader' AND NOT coalesce(p_team_leader_enabled, false))
    OR (p_tier = 'executive'   AND NOT coalesce(p_executive_enabled, false))
  );

  -- computeManagerQueueReady(): gates the engineer/admin end of the pipeline.
  v_queue_ready := CASE
    WHEN v_terminal                     THEN false
    WHEN p_status = 'level_2_verified'  THEN true
    WHEN p_tier = 'engineer'            THEN v_open
    WHEN coalesce(p_handoff, false)     THEN true
    WHEN v_skipped AND v_open           THEN true
    WHEN NOT p_hierarchy_enabled AND v_open THEN true
    ELSE false
  END;

  -- Tier reviewers act on their own tier; engineer/admin additionally need the
  -- queue-ready gate so rows still sitting at a lower tier are not offered.
  -- A caller specifically assigned as the terminal 'engineer'-tier reviewer is
  -- always acting in the MANAGER capacity for that tier -- there is no tier
  -- after 'engineer' to verify into -- so route them through the manager
  -- branch below even when their org role happens to be 'team_leader'/
  -- 'executive'.
  IF p_role IN ('team_leader','executive') AND p_tier IS DISTINCT FROM 'engineer' THEN
    v_actionable := v_can_act AND v_open;
  ELSE
    v_actionable := v_can_act AND v_queue_ready;
  END IF;

  v_stage := coalesce(p_tier, 'engineer');

  v_reason := CASE
    WHEN v_actionable                          THEN 'actionable_at_' || v_stage
    WHEN NOT (v_is_reviewer OR v_is_engineer)
         AND NOT (p_role = 'admin' AND p_tier = 'admin') THEN 'not_assigned_to_caller'
    WHEN NOT v_can_act                         THEN 'role_cannot_act_at_' || v_stage
    WHEN NOT v_open                            THEN 'status_not_open'
    WHEN NOT v_queue_ready                     THEN 'awaiting_' || v_stage || '_tier'
    ELSE 'not_actionable'
  END;

  v_actions := CASE
    WHEN NOT v_actionable                       THEN '[]'::jsonb
    WHEN p_role IN ('team_leader','executive') AND p_tier IS DISTINCT FROM 'engineer' THEN '["verify","reject"]'::jsonb
    ELSE '["approve","reject","correct"]'::jsonb
  END;

  RETURN jsonb_build_object(
    'is_actionable', v_actionable,
    'actionable_stage', v_stage,
    'actionable_reason', v_reason,
    'available_actions', v_actions,
    'view_only', NOT v_actionable);
END;
$function$;

COMMIT;
