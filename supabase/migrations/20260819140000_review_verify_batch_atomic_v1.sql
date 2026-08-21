-- DOC-098 — Atomic per-batch hierarchy verification.
--
-- ============================================================================
-- STATUS: DEBUG-BRANCH ONLY at commit time. Scheduled for same-day Production
-- deployment per explicit owner authorization (DOC-098 §11/§12). Additive
-- only; existing single-expense review_advance_expense_hierarchy_tier and the
-- per-expense client Bulk Verify/Verify paths are untouched and remain fully
-- functional.
-- ============================================================================
--
-- PURPOSE
-- Fixes the root cause proven in Documentations MD/batch-verification-
-- integrity-audit.md: /review's Bulk Verify expands a selected batch only
-- over browser-held rows, with no server-side guarantee that every current
-- non-terminal child is targeted, and advances each child independently —
-- so a batch of 11 can end up 7 advanced / 4 never touched, with the
-- reviewer never told anything was left behind (confirmed live in
-- Production: transactions 03197-03204, 03864, 07840, 00518, 09991, 01104).
--
-- This RPC makes a batch-level hierarchy verification ATOMIC: the server —
-- never the browser — resolves every current non-terminal child of the
-- batch, locks them all, validates every one against the caller's real,
-- freshly-derived tier, and either advances every eligible child in ONE
-- transaction or mutates nothing at all and returns exactly which children
-- blocked it and why.
--
-- SECURITY REVISION (pre-first-deployment, DOC-098 same-day hotfix review):
-- the original draft accepted the next tier/reviewer/engineer as CLIENT
-- parameters (p_next_approval_tier, p_next_assigned_reviewer_id,
-- p_next_assigned_engineer_id), on the assumption that
-- review_advance_expense_hierarchy_tier independently validated them. Reading
-- its exact live definition (via pg_get_functiondef) proved that assumption
-- false: it validates only that p_next_approval_tier is one of the four
-- known tier strings, and otherwise writes assigned_reviewer_id/
-- assigned_engineer_id directly from whatever the caller supplied (its own
-- team-manager override applies ONLY when p_next_approval_tier = 'engineer'
-- AND the employee has a team). This is a pre-existing gap in the already-
-- live single-expense function, not something this migration introduced —
-- but a batch wrapper trusting the same client input multiplies the blast
-- radius per call, so THIS function now derives the next tier/reviewer/
-- engineer itself, server-side, using the exact same priority logic as
-- src/lib/approvalHierarchy.ts's resolveNextTierAfterVerify /
-- resolveExecutiveReviewerId / resolveReviewerForTier (read in full for this
-- revision) — never a client-supplied value. p_next_approval_tier,
-- p_next_assigned_reviewer_id and p_next_assigned_engineer_id are REMOVED
-- from this function's signature entirely: there is nothing left to tamper
-- with. Proven live (BEGIN/ROLLBACK) via tamper scenarios R1-R7 in DOC-098.
--
-- Because every child of a batch shares one employee, routing depends only
-- on the employee's team/reporting chain and the caller's own tier — so it
-- is computed ONCE per batch call, not per child, exactly mirroring how the
-- existing single-expense advanceExpenseTier client code already computes
-- it once per verify.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.review_verify_batch_atomic_v1(
  p_batch_id uuid,
  p_comment  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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

  -- ── 1. Resolve the batch's organisation AND employee (also proves the
  --      batch exists) — every child of a batch shares one employee, so
  --      routing needs only one representative row. ─────────────────────────
  SELECT organization_id, user_id INTO v_org_id, v_employee_id
  FROM public.expenses WHERE batch_id = p_batch_id LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'batch_not_found', 'batch_id', p_batch_id);
  END IF;

  -- ── 2. Caller must be an active team_leader or executive in this org. ────
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

  -- ── 3. SERVER-DERIVED next tier/reviewer/engineer — no client input is
  --      trusted for any of this (DOC-098 security revision). Mirrors
  --      approvalHierarchy.ts's resolveNextTierAfterVerify exactly. ─────────
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

  -- Engineer-tier candidate (used both as the actual target when routing to
  -- engineer, and as the assigned_engineer_id fallback when routing to
  -- executive) — mirrors resolveReviewerForTier('engineer', input).
  v_engineer_candidate := COALESCE(
    CASE WHEN v_reporting_supervisor_role IN ('engineer', 'admin') THEN v_reporting_engineer_id END,
    v_team_manager_user_id,
    v_reporting_engineer_id
  );

  IF v_is_tl AND v_hierarchy_executive_enabled THEN
    -- resolveExecutiveReviewerId's exact priority chain.
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
      -- No executive reviewer resolvable — falls through to engineer tier,
      -- exactly as findNextResolvableTier does (never "executive" + NULL).
      v_target_tier := 'engineer';
    END IF;
  ELSE
    -- team_leader with hierarchy_executive disabled, or executive caller:
    -- next tier is always 'engineer'.
    v_target_tier := 'engineer';
  END IF;

  IF v_target_tier = 'engineer' THEN
    v_target_reviewer := v_engineer_candidate;
    v_target_engineer := v_engineer_candidate;
  END IF;

  -- ── 4. Lock every current non-terminal, not-already-fully-advanced child of
  --      THIS batch, in deterministic order — this is the server-authoritative
  --      batch membership; the browser's allExpenses is never consulted. ────
  FOR v_child IN
    SELECT * FROM public.expenses
    WHERE batch_id = p_batch_id
      AND organization_id = v_org_id
      AND status NOT IN ('approved', 'rejected', 'paid', 'level_2_verified')
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Authorization: reuse the SAME live predicate the single-expense path
    -- uses (assignment/tier match + current-supervisor fallback) — never a
    -- second, potentially-diverging authorization rule.
    --
    -- FAIL-CLOSED NOTE: expense_hierarchy_reviewer_can_act can return SQL
    -- NULL (not just true/false) — e.g. its assignment check is
    -- `e.assigned_reviewer_id = v_uid OR e.assigned_engineer_id = v_uid`,
    -- and when assigned_engineer_id IS NULL that comparison itself is NULL,
    -- poisoning the surrounding AND/OR to NULL under three-valued logic
    -- (proven live via BEGIN/ROLLBACK: an unassigned, non-supervisor
    -- executive caller against a team_leader-assigned expense returned NULL,
    -- not false). `IF NOT NULL THEN` is itself NULL, which PL/pgSQL treats
    -- as "condition not met" and silently skips this branch — so a plain
    -- `IF NOT ...can_act(...) THEN` would let an unauthorized caller fall
    -- through to the eligible set. `IS NOT TRUE` treats NULL the same as
    -- false, so an ambiguous authorization result blocks by default.
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

  -- ── 5. ALL-OR-NOTHING: any blocker at all means zero mutation. No child of
  --      this batch is touched, including ones that WOULD have been eligible
  --      — the whole point is that a batch can never split. ─────────────────
  IF jsonb_array_length(v_blockers) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'batch_verification_blocked',
      'batch_id', p_batch_id,
      'blockers', v_blockers
    );
  END IF;

  IF array_length(v_eligible_ids, 1) IS NULL THEN
    -- Nothing to verify (e.g. every child already terminal/level_2_verified).
    RETURN jsonb_build_object(
      'ok', true, 'batch_id', p_batch_id, 'verified_count', 0, 'transactions', '[]'::jsonb
    );
  END IF;

  -- ── 6. Advance every eligible child, in the SAME transaction, by delegating
  --      to the existing, unmodified, already-authoritative
  --      review_advance_expense_hierarchy_tier for each one, using the
  --      SERVER-DERIVED target tier/reviewer/engineer computed in step 3 —
  --      identical for every child since they share one employee. If any
  --      call raises, Postgres rolls back this entire function call — every
  --      child already advanced earlier in this loop reverts too.
  --
  --      AUDIT NOTE: review_advance_expense_hierarchy_tier itself does NOT
  --      insert an audit_logs row (that is done by the CLIENT, via
  --      ExpenseService.logAction, in a SEPARATE request AFTER the RPC
  --      returns — not atomic with the mutation even for today's
  --      single-expense Verify). For a batch, relying on N separate
  --      post-hoc client calls would reintroduce exactly the kind of
  --      partial-completion risk this RPC exists to eliminate. So this
  --      function writes each child's audit_logs row itself, in this same
  --      transaction — if anything later in the loop fails, these inserts
  --      roll back along with the mutations they describe. ────────────────
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
$$;

REVOKE ALL   ON FUNCTION public.review_verify_batch_atomic_v1(uuid, text) FROM PUBLIC;
REVOKE ALL   ON FUNCTION public.review_verify_batch_atomic_v1(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_verify_batch_atomic_v1(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.review_verify_batch_atomic_v1(uuid, text) IS
  'Atomically advances every eligible non-terminal child of one batch at a '
  'hierarchy tier — all children advance together or none do. Resolves both '
  'batch membership AND next-tier routing (reviewer/engineer) server-side '
  '(DOC-098 security revision: no longer accepts client-supplied routing '
  'parameters); reuses expense_hierarchy_reviewer_can_act for authorization '
  'and review_advance_expense_hierarchy_tier for the actual mutation, so it '
  'cannot diverge from the single-expense verification contract. DOC-098.';
