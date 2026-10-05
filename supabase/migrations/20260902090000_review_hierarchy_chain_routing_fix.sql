-- Review Expenses hotfix, corrected: the previous forward migration
-- (20260902070000) widened the final-tier authorization check to trust
-- whichever caller was already persisted as an expense's assigned final
-- reviewer, regardless of their organization role. Forensic investigation
-- with the ACTUAL business hierarchy identified proved that diagnosis was
-- wrong: the persisted assignment itself was incorrect, produced by a real
-- routing bug, not a legitimate "executive doubles as final approver"
-- business rule. No such rule exists anywhere in current data -- every
-- executive/team-leader with no engineer/admin reviewer anywhere above them
-- in their own reporting chain is a synthetic QA/test fixture with zero
-- real expenses ever assigned to them.
--
-- ROOT CAUSE (proven live, read-only): an employee's business hierarchy can
-- be a genuine two-hop chain -- Employee reports to an Executive (who
-- verifies), and that Executive themselves reports to a separate,
-- dedicated engineer-role Manager (who gives final approval). When
-- resolving the final "engineer" tier reviewer for an expense,
-- review_verify_batch_atomic_v1's `v_engineer_candidate` COALESCE chain
-- only recognized the employee's DIRECT reporting_engineer_id as the final
-- reviewer when that person's own role was ALREADY 'engineer'/'admin', or
-- fell back to a team's manager_user_id -- with no further step. When the
-- direct supervisor's role was 'executive' (not yet 'engineer') and no team
-- existed, the COALESCE's last fallback used that executive directly,
-- instead of continuing up the chain to the real engineer-role Manager one
-- hop further. This silently routed final approval to the Executive
-- instead of the Manager for every employee whose only recorded supervisor
-- is an Executive with their own separate Manager above them.
--
-- Because expense_manager_can_review/_debug_review_actionability_v1's own
-- role check (correctly) requires role='engineer'/'admin' to approve, the
-- misrouted Executive was denied normal approval -- exactly the reported
-- "Level 2 Verified" expenses stuck showing "Waiting for previous
-- verification" for the real business Manager, who was never the one the
-- expense pointed to in the first place.
--
-- FIX (this migration):
--  1. review_verify_batch_atomic_v1: v_engineer_candidate now walks UP the
--     employee's reporting chain (bounded depth 10, same convention as
--     manager_expense_visible_to_user's existing recursive chain) past any
--     non-engineer/admin supervisor, to find the real final-tier reviewer.
--     Team routing and the "supervisor already engineer/admin" fast path
--     are both unchanged and still take priority; the chain walk is only a
--     smarter version of the final fallback that previously used the
--     immediate (possibly non-engineer) supervisor unconditionally. An
--     organization that genuinely has no engineer/admin anywhere in a
--     reviewer's chain keeps today's exact fallback behavior.
--  2. expense_manager_can_review, review_approve_expense,
--     _debug_review_actionability_v1: REVERTED to their pre-20260902070000
--     definitions. The "trust the persisted assignment regardless of role"
--     widening is removed -- it is not needed once routing is fixed (a
--     correctly-routed engineer-role Manager already satisfies the
--     original, unmodified role check), and leaving it in place would let
--     a future routing bug silently hand final approval to the wrong
--     person again instead of surfacing as "waiting".
--
-- A separate, one-time data repair (documented in
-- Documentations MD/review-verified-ready-classification.md, executed
-- directly against Production after this migration, NOT part of this
-- migration file) re-points the finite set of already-existing
-- level_2_verified expenses that this exact routing gap misassigned, using
-- the identical chain-walk logic, to the correctly-resolved engineer/admin
-- reviewer for each affected employee. It changes ONLY
-- assigned_reviewer_id/assigned_engineer_id -- never status, approval_tier,
-- amount, balance, or verification history.

BEGIN;

CREATE OR REPLACE FUNCTION public.expense_manager_can_review(e expenses, v_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'engineer'
      AND om.is_active = true
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
  IF p_role IN ('team_leader','executive') THEN
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
    WHEN p_role IN ('team_leader','executive')  THEN '["verify","reject"]'::jsonb
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

CREATE OR REPLACE FUNCTION public.review_verify_batch_atomic_v1(p_batch_id uuid, p_comment text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid                             uuid := auth.uid();
  v_org_id                          uuid;
  v_employee_id                     uuid;
  v_is_tl                           boolean;
  v_is_exec                         boolean;
  v_hierarchy_executive_enabled     boolean;
  v_reporting_engineer_id           uuid;
  v_reporting_supervisor_role       text;
  v_verifier_supervisor_id          uuid;
  v_verifier_supervisor_role        text;
  v_supervisor_reporting_engineer_id uuid;
  v_supervisor_reporting_role       text;
  v_team_executive_user_id          uuid;
  v_team_manager_user_id            uuid;
  v_resolved_executive              uuid;
  v_engineer_candidate              uuid;
  -- Resolved by walking UP the employee's reporting chain (bounded depth
  -- 10, same convention as manager_expense_visible_to_user's recursive
  -- chain) past any non-engineer/admin supervisor -- e.g. an Executive who
  -- is themselves managed by the organization's real engineer-tier Manager
  -- -- to find the canonical final-tier reviewer.
  v_chain_engineer_candidate        uuid;
  v_target_tier                     text;
  v_target_reviewer                 uuid;
  v_target_engineer                 uuid;
  v_child                           public.expenses%ROWTYPE;
  v_blockers                        jsonb := '[]'::jsonb;
  v_eligible_ids                    uuid[] := ARRAY[]::uuid[];
  v_transactions                    jsonb := '[]'::jsonb;
  v_advance                         jsonb;
  v_status_before                   public.expense_status;
  v_tier_before                     text;
  v_after                           jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT organization_id, user_id INTO v_org_id, v_employee_id
  FROM public.expenses WHERE batch_id = p_batch_id LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'batch_not_found', 'batch_id', p_batch_id);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = v_org_id
      AND om.role = 'team_leader' AND om.is_active = true
  ) INTO v_is_tl;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = v_org_id
      AND om.role = 'executive' AND om.is_active = true
  ) INTO v_is_exec;

  IF NOT (v_is_tl OR v_is_exec) THEN
    RAISE EXCEPTION 'Only team leaders and executives can bulk-verify at hierarchy tiers';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_features f
    WHERE f.organization_id = v_org_id AND f.feature_key = 'approval_hierarchy' AND f.enabled = true
  ) AND EXISTS (
    SELECT 1 FROM public.organization_features f
    WHERE f.organization_id = v_org_id AND f.feature_key = 'hierarchy_executive' AND f.enabled = true
  ) INTO v_hierarchy_executive_enabled;

  SELECT reporting_engineer_id INTO v_reporting_engineer_id
  FROM public.profiles WHERE user_id = v_employee_id AND organization_id = v_org_id;

  IF v_reporting_engineer_id IS NOT NULL THEN
    SELECT role INTO v_reporting_supervisor_role
    FROM public.organization_memberships
    WHERE user_id = v_reporting_engineer_id AND organization_id = v_org_id AND is_active = true;
  END IF;

  SELECT t.executive_user_id, t.manager_user_id
  INTO v_team_executive_user_id, v_team_manager_user_id
  FROM public.team_members tm
  JOIN public.teams t ON t.id = tm.team_id AND t.organization_id = tm.organization_id
  WHERE tm.user_id = v_employee_id AND tm.organization_id = v_org_id
  LIMIT 1;

  -- Walk UP the employee's reporting chain past any non-engineer/admin
  -- supervisor to find the canonical final reviewer. Only used as a
  -- fallback below -- a direct supervisor who is ALREADY engineer/admin, or
  -- a team's own manager_user_id, still take priority unchanged.
  IF v_reporting_engineer_id IS NOT NULL
     AND COALESCE(v_reporting_supervisor_role, '') NOT IN ('engineer', 'admin') THEN
    WITH RECURSIVE chain(current_user_id, depth) AS (
      SELECT v_reporting_engineer_id, 1
      UNION ALL
      SELECT p.reporting_engineer_id, c.depth + 1
      FROM chain c
      JOIN public.profiles p ON p.user_id = c.current_user_id AND p.organization_id = v_org_id
      WHERE c.depth < 10 AND p.reporting_engineer_id IS NOT NULL
    )
    SELECT c.current_user_id INTO v_chain_engineer_candidate
    FROM chain c
    JOIN public.organization_memberships om
      ON om.user_id = c.current_user_id AND om.organization_id = v_org_id AND om.is_active = true
    WHERE om.role IN ('engineer', 'admin')
    ORDER BY c.depth
    LIMIT 1;
  END IF;

  v_engineer_candidate := COALESCE(
    CASE WHEN v_reporting_supervisor_role IN ('engineer', 'admin') THEN v_reporting_engineer_id END,
    v_team_manager_user_id,
    v_chain_engineer_candidate,
    v_reporting_engineer_id
  );

  IF v_is_tl AND v_hierarchy_executive_enabled THEN
    SELECT reporting_engineer_id INTO v_verifier_supervisor_id
    FROM public.profiles WHERE user_id = v_uid AND organization_id = v_org_id;
    IF v_verifier_supervisor_id IS NOT NULL THEN
      SELECT role INTO v_verifier_supervisor_role
      FROM public.organization_memberships
      WHERE user_id = v_verifier_supervisor_id AND organization_id = v_org_id AND is_active = true;
    END IF;

    IF v_reporting_supervisor_role = 'team_leader' AND v_reporting_engineer_id IS NOT NULL THEN
      SELECT reporting_engineer_id INTO v_supervisor_reporting_engineer_id
      FROM public.profiles WHERE user_id = v_reporting_engineer_id AND organization_id = v_org_id;
      IF v_supervisor_reporting_engineer_id IS NOT NULL THEN
        SELECT role INTO v_supervisor_reporting_role
        FROM public.organization_memberships
        WHERE user_id = v_supervisor_reporting_engineer_id AND organization_id = v_org_id AND is_active = true;
      END IF;
    END IF;

    v_resolved_executive := CASE
      WHEN v_verifier_supervisor_role = 'executive' THEN v_verifier_supervisor_id
      WHEN v_reporting_supervisor_role = 'executive' THEN v_reporting_engineer_id
      WHEN v_supervisor_reporting_role = 'executive' THEN v_supervisor_reporting_engineer_id
      ELSE v_team_executive_user_id
    END;

    IF v_resolved_executive IS NOT NULL THEN
      v_target_tier := 'executive';
      v_target_reviewer := v_resolved_executive;
      v_target_engineer := COALESCE(v_engineer_candidate, v_resolved_executive);
    ELSE
      v_target_tier := 'engineer';
    END IF;
  ELSE
    v_target_tier := 'engineer';
  END IF;

  IF v_target_tier = 'engineer' THEN
    v_target_reviewer := v_engineer_candidate;
    v_target_engineer := v_engineer_candidate;
  END IF;

  -- HOTFIX: explicit draft-child contamination guard (batch integrity, not authorization)
  IF EXISTS (
    SELECT 1 FROM public.expenses
    WHERE batch_id = p_batch_id AND organization_id = v_org_id
      AND status = 'draft'::public.expense_status
  ) AND EXISTS (
    SELECT 1 FROM public.expenses
    WHERE batch_id = p_batch_id AND organization_id = v_org_id
      AND status IN (
        'submitted'::public.expense_status,
        'edited'::public.expense_status,
        'under_review'::public.expense_status,
        'level_1_verified'::public.expense_status
      )
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'invalid_batch_membership_draft_child',
      'batch_id', p_batch_id,
      'blockers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'expense_id', e.id,
          'transaction_number', e.transaction_number,
          'status', e.status,
          'reason', 'invalid_batch_membership_draft_child'
        ) ORDER BY e.id)
        FROM public.expenses e
        WHERE e.batch_id = p_batch_id AND e.organization_id = v_org_id
          AND e.status = 'draft'::public.expense_status
      ), '[]'::jsonb)
    );
  END IF;

  -- HOTFIX: authoritative review membership uses explicit review-stage allowlist
  FOR v_child IN
    SELECT * FROM public.expenses
    WHERE batch_id = p_batch_id
      AND organization_id = v_org_id
      AND status IN (
        'submitted'::public.expense_status,
        'edited'::public.expense_status,
        'under_review'::public.expense_status,
        'level_1_verified'::public.expense_status
      )
    ORDER BY id
    FOR UPDATE
  LOOP
    IF public.expense_hierarchy_reviewer_can_act(v_child, v_uid) IS NOT TRUE THEN
      v_blockers := v_blockers || jsonb_build_object(
        'expense_id', v_child.id,
        'transaction_number', v_child.transaction_number,
        'employee_id', (SELECT p.employee_id FROM public.profiles p WHERE p.user_id = v_child.user_id),
        'status', v_child.status,
        'approval_tier', v_child.approval_tier,
        'reason', 'not_assigned_or_not_permitted'
      );
      CONTINUE;
    END IF;

    IF v_is_tl AND v_child.status NOT IN ('submitted', 'edited') THEN
      v_blockers := v_blockers || jsonb_build_object(
        'expense_id', v_child.id,
        'transaction_number', v_child.transaction_number,
        'employee_id', (SELECT p.employee_id FROM public.profiles p WHERE p.user_id = v_child.user_id),
        'status', v_child.status,
        'approval_tier', v_child.approval_tier,
        'reason', 'wrong_status_for_team_leader_tier'
      );
      CONTINUE;
    END IF;

    IF v_is_exec AND v_child.status NOT IN ('submitted', 'edited', 'level_1_verified') THEN
      v_blockers := v_blockers || jsonb_build_object(
        'expense_id', v_child.id,
        'transaction_number', v_child.transaction_number,
        'employee_id', (SELECT p.employee_id FROM public.profiles p WHERE p.user_id = v_child.user_id),
        'status', v_child.status,
        'approval_tier', v_child.approval_tier,
        'reason', 'wrong_status_for_executive_tier'
      );
      CONTINUE;
    END IF;

    v_eligible_ids := array_append(v_eligible_ids, v_child.id);
  END LOOP;

  IF jsonb_array_length(v_blockers) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'batch_verification_blocked',
      'batch_id', p_batch_id,
      'blockers', v_blockers
    );
  END IF;

  IF array_length(v_eligible_ids, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'batch_id', p_batch_id, 'verified_count', 0, 'transactions', '[]'::jsonb
    );
  END IF;

  FOR v_child IN
    SELECT * FROM public.expenses WHERE id = ANY(v_eligible_ids) ORDER BY id
  LOOP
    v_status_before := v_child.status;
    v_tier_before    := v_child.approval_tier;

    v_advance := public.review_advance_expense_hierarchy_tier(
      v_child.id,
      v_target_tier,
      v_target_reviewer,
      v_target_engineer,
      p_comment
    );

    INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
    VALUES (
      v_child.id,
      v_uid,
      v_org_id,
      'tier_advanced',
      COALESCE(p_comment, format('Batch verified by %s; advanced to %s', CASE WHEN v_is_tl THEN 'team leader' ELSE 'executive' END, COALESCE(v_target_tier, 'admin')))
    );

    SELECT to_jsonb(ex) INTO v_after FROM public.expenses ex WHERE ex.id = v_child.id;

    v_transactions := v_transactions || jsonb_build_object(
      'transaction_number', v_child.transaction_number,
      'employee_id', (SELECT p.employee_id FROM public.profiles p WHERE p.user_id = v_child.user_id),
      'status_before', v_status_before,
      'status_after', v_after->>'status',
      'tier_before', v_tier_before,
      'tier_after', v_after->>'approval_tier'
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'verified_count', array_length(v_eligible_ids, 1),
    'transactions', v_transactions
  );
END;
$function$;

COMMIT;
