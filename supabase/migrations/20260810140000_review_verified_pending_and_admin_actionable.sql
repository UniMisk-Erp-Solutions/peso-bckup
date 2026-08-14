-- Review queue — align `verified` with the org-admin approval contract.
--
-- FOLLOW-UP to 20260810120000 (org-admin super-approver for submitted/edited/
-- level_1_verified/level_2_verified). A read-only audit then proved one residual
-- queue <-> approval mismatch: review_approve_expense (V1, called by V2) allows
-- an org admin to approve status='verified' (it is in the `IF v_is_admin`
-- allowed list, balance not yet deducted), and ExpenseService /
-- ADMIN_APPROVABLE_STATUSES agree — but the Review queue treated 'verified' as
-- terminal/Completed and view-only, so the admin could not act on it here.
-- Live MicroLink had 2 such expenses.
--
-- PRODUCT DECISION (owner-authorized): plain 'verified' is NOT financially final
-- for an org admin; it remains eligible for final admin approval. So the queue is
-- brought into line with the EXISTING financial-approval contract. V1/V2 are NOT
-- tightened; authorization is unchanged.
--
-- This migration changes ONLY the two pure classifier/actionability helpers:
--   1. _debug_review_status_class_v1 — 'verified' moves terminal -> pending, so
--      the row lives in the Pending Review workflow bucket (like level_2_verified)
--      instead of Completed.
--   2. _debug_review_actionability_v1 — the org-admin super-approver fast-path now
--      also covers 'verified', and is evaluated BEFORE the terminal gate so the
--      old terminal branch cannot swallow 'verified' first.
--
-- The queue page RPC (get_debug_review_queue_page_v1) is deliberately NOT touched:
--   * pending_review = count(class='pending') and completed_review =
--     count(class='terminal') follow the classifier automatically, so the 2
--     verified rows move Completed -> Pending with no RPC edit.
--   * the `verified` summary field is a COMPLETED-bucket breakdown
--     (FILTER ... AND class='terminal'); with 'verified' now pending it reads 0,
--     which is correct (no verified rows remain in Completed) and keeps the
--     reconciliation invariant completed_review = verified + approved + rejected
--     + paid + other_terminal balanced (both sides drop by the verified count).
--   * pending_review = actionable_now + active_not_actionable_now still holds:
--     the verified rows are pending and, for the admin, actionable.
--
-- NON-ADMIN SEMANTICS ARE UNCHANGED. 'verified' stays in v_terminal, so a
-- non-admin caller (engineer/team_leader/executive) still hits the terminal
-- branch and remains view-only on 'verified' — no one but an admin gains action.
-- Self-review remains excluded upstream (_debug_review_assigned_scope_v1 drops
-- user_id = auth.uid()) plus the client isSelfOwned backstop.
--
-- No data is changed. No expense status is rewritten. Pure function correction.
-- Rollback SQL is at the bottom (re-apply the pre-change definitions).

-- 1 ── Status classification: 'verified' becomes a pending workflow status ------
CREATE OR REPLACE FUNCTION public._debug_review_status_class_v1(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_status IN ('submitted','edited','under_review',
                      'level_1_verified','level_2_verified','verified') THEN 'pending'
    WHEN p_status IN ('approved','rejected','paid') THEN 'terminal'
    ELSE 'unclassified'
  END;
$$;

REVOKE ALL ON FUNCTION public._debug_review_status_class_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_status_class_v1(text) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_status_class_v1(text) TO authenticated;

COMMENT ON FUNCTION public._debug_review_status_class_v1(text) IS
  'Returns pending | terminal | unclassified. ''verified'' is a PENDING workflow '
  'status (awaiting final admin approval; balance not yet deducted), not '
  'Completed. Only approved/rejected/paid are terminal. An unfamiliar status '
  'becomes unclassified so reconciliation fails loudly.';

-- 2 ── Actionability: admin super-approver also covers 'verified' ---------------
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
  -- direct-assignment gates). Self-owned rows never reach here — the assigned
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
$$;

REVOKE ALL ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) TO authenticated;

COMMENT ON FUNCTION public._debug_review_actionability_v1(text,uuid,text,text,uuid,uuid,boolean,boolean,boolean,boolean) IS
  'THE canonical debug actionability definition (DOC-080). canRoleActOnExpense + '
  'computeManagerQueueReady, PLUS the org-admin super-approver rule '
  '(ADMIN_APPROVABLE_STATUSES incl. verified) that review_approve_expense '
  'enforces. Admin fast-path runs before the terminal gate so verified is '
  'offered to admins; non-admins keep view-only on verified. One definition only.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Pure-function migration; re-apply the prior definitions to fully revert:
--   * _debug_review_status_class_v1 — remove 'verified' from the pending list and
--     restore it to the terminal list (state from 20260802020000).
--   * _debug_review_actionability_v1 — drop 'verified' from v_admin_open and move
--     the admin fast-path back BELOW the `IF v_terminal` block (state from
--     20260810120000). No data rollback is required.
