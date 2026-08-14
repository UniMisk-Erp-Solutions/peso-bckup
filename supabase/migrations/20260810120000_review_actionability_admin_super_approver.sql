-- Review queue actionability — restore the org-admin super-approver rule.
--
-- CONFIRMED PRODUCTION DEFECT (Manager Review, MicroLink)
-- An org admin opening /review saw ~9,157 assigned rows but only ~1 actionable,
-- with NO bulk checkboxes and every submitted non-batch row labelled "View".
-- Live read-only audit of transactions 10483/10484/10485 (status=submitted,
-- approval_tier=executive, non-batch) returned, for the admin caller:
--     is_actionable=false  actionable_reason=not_assigned_to_caller
--     available_actions=[]  view_only=true
-- and the pending population bucketed 100% as not_assigned_to_caller
-- (5896 executive-tier + 2179 engineer-tier + 1775 team_leader-tier).
--
-- ROOT CAUSE
-- public._debug_review_actionability_v1 (THE canonical queue/detail helper) was
-- ported from canRoleActOnExpense, which only lets an admin act when
-- approval_tier = 'admin' or when the admin is the direct assigned reviewer /
-- engineer. It never implemented the org-admin SUPER-APPROVER rule that the rest
-- of the system enforces:
--   * public.review_approve_expense (V1, called by review_approve_expense_v2):
--       IF v_is_admin THEN allow status IN
--       ('submitted','edited','verified','level_1_verified','level_2_verified')
--       regardless of tier or assignment, auto-verifying 'submitted'/'edited'.
--   * public.review_reject_expense path / ExpenseService.rejectExpense: admins
--       skip the assignment check (IF NOT isAdmin ...).
--   * approvalHierarchy.ts ADMIN_APPROVABLE_STATUSES + isAdminApprovableStatus,
--       used by AdminPanel, MobileAdminExpenseDetailView, batchExpenseReview.
-- Because no MicroLink expense ever sits at approval_tier='admin', the admin
-- could act on nothing through the queue. The queue therefore DISAGREED with the
-- approval authorization: the RPC would approve these rows, but the queue marked
-- them view_only, so the checkbox (gated on server is_actionable /
-- available_actions) never rendered.
--
-- FIX (smallest correct change)
-- Add a single admin fast-path to _debug_review_actionability_v1: when the caller
-- is an org admin and the expense is in an admin-approvable, NON-terminal status,
-- return is_actionable=true with the same approver triad the engineer/admin
-- actionable branch already returns. Everything else is byte-for-byte the prior
-- definition. 'verified'/'approved'/'rejected' remain terminal/view_only exactly
-- as before (they classify as Completed, not Pending).
--
-- SAFETY
--   * Server stays authoritative; this only widens the queue/detail signal to
--     MATCH the approval RPC that already authorizes admins.
--   * Org isolation: helper is pure (no table access); scope/detail callers pass
--     the caller context. Unchanged.
--   * Self-review: the assigned-scope helper still excludes e.user_id=auth.uid(),
--     and actionEligibility.isSelfOwned remains the client backstop. The helper
--     never received the owner id and still does not — no self path is widened.
--   * Assignment scope, hierarchy tiers, non-admin behaviour: untouched.
--   * V2 financial transaction (locking, dedup, sequential): untouched.
-- Rollback SQL is at the bottom of this file (commented).

CREATE OR REPLACE FUNCTION public._debug_review_actionability_v1(
  p_role               text,
  p_caller             uuid,
  p_status             text,
  p_tier               text,
  p_assigned_reviewer  uuid,
  p_assigned_engineer  uuid,
  p_hierarchy_enabled  boolean,
  p_team_leader_enabled boolean,
  p_executive_enabled  boolean,
  p_handoff            boolean
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  -- MANAGER_ACTIONABLE_STATUSES, verbatim from managerActionableExpenses.ts
  v_open_statuses text[] := ARRAY['submitted','edited','under_review',
                                  'level_1_verified','level_2_verified'];
  -- ADMIN_APPROVABLE_STATUSES (approvalHierarchy.ts) intersected with the
  -- non-terminal set: the statuses at which an org admin may approve directly,
  -- skipping hierarchy tier requirements. 'verified' is intentionally excluded
  -- here because the helper classifies it terminal (Completed), matching the
  -- prior queue behaviour; the AdminPanel detail path still approves 'verified'.
  v_admin_open    text[] := ARRAY['submitted','edited',
                                  'level_1_verified','level_2_verified'];
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
  IF v_terminal THEN
    RETURN jsonb_build_object(
      'is_actionable', false,
      'actionable_stage', 'terminal',
      'actionable_reason', 'status_' || p_status,
      'available_actions', '[]'::jsonb,
      'view_only', true);
  END IF;

  -- Org-admin super-approver (skips hierarchy tier + direct-assignment gates,
  -- mirroring review_approve_expense's `IF v_is_admin` branch and
  -- isAdminApprovableStatus). Self-owned rows never reach here — the assigned
  -- scope helper excludes them, and the client re-checks isSelfOwned.
  IF p_role = 'admin' AND p_status = ANY(v_admin_open) THEN
    RETURN jsonb_build_object(
      'is_actionable', true,
      'actionable_stage', coalesce(p_tier, 'admin'),
      'actionable_reason', 'admin_approvable',
      'available_actions', '["approve","reject","correct"]'::jsonb,
      'view_only', false);
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
$$;

REVOKE ALL ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) TO authenticated;

COMMENT ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) IS
  'THE canonical debug actionability definition (DOC-080). Ported from canRoleActOnExpense + computeManagerQueueReady, PLUS the org-admin super-approver rule (ADMIN_APPROVABLE_STATUSES) that review_approve_expense enforces. Do not add a second definition.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- To revert, CREATE OR REPLACE the function WITHOUT the admin fast-path block
-- (the `IF p_role = 'admin' AND p_status = ANY(v_admin_open)` return) and drop
-- the v_admin_open declaration, restoring migration
-- 20260801150000_debug_review_queue_v1_corrections.sql's body verbatim. No data
-- migration is involved; the function is pure, so a replace is a full rollback.
