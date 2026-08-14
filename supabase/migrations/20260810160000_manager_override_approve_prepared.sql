-- DOC-080 — PREPARED (NOT APPLIED) Manager engineer-override approval
--
-- ============================================================================
-- STATUS: APPLIED to Production 2026-08-11 under explicit owner authorization
-- (backup pesowise_20260811T061425Z_pre_manager_override.dump taken first,
-- SHA-256 2ad98d9d…4325a1). Audited against live review_approve_expense_v2 first
-- — the deduction block below matches V2's lock/deduction semantics exactly. The
-- frontend discovers this capability at runtime via
-- review_manager_override_capabilities_v1 (companion migration
-- 20260811120000) and fails closed where it is absent. Validated live with a
-- transactional E2E approval + a full security matrix, all under BEGIN…ROLLBACK
-- (zero permanent mutation). CREATE OR REPLACE, so this file is safe to re-run.
-- (Schema reload is issued by the companion capability migration.)
-- ============================================================================
--
-- PURPOSE
-- Allow an ENGINEER (the "Manager" role) to approve an expense that is currently
-- WAITING at a later hierarchy tier (team_leader / executive) within their own
-- manager scope. It overrides ONLY the tier gate that review_approve_expense
-- (V1) enforces on the manager path; every other guard is retained:
--   * engineer-only (executive / team_leader / admin gain nothing here);
--   * same organization, active membership;
--   * no self-review;
--   * terminal expenses (approved / rejected / paid) are never re-approved;
--   * legitimate manager scope — the SAME expense_manager_can_review check V1 uses;
--   * the engineer_approval_limit (Rs 5000 default) money ceiling is RETAINED;
--   * ONE atomic balance deduction reusing the exact machinery of
--     review_approve_expense_v2, sharing expense_balance_deductions and its
--     UNIQUE(expense_id) — so an expense can never be debited by BOTH V2 and this
--     override;
--   * a truthful audit_logs entry that names the override explicitly.
--
-- It does NOT delegate to V1: V1's manager path raises on team_leader/executive
-- tier, which is the exact gate being overridden. The approval UPDATE and the
-- deduction block below are therefore inlined and kept byte-for-byte aligned with
-- review_approve_expense_v2's deduction section.

CREATE OR REPLACE FUNCTION public.review_approve_expense_manager_override_v1(
  p_expense_id uuid,
  p_comment    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  e                public.expenses%ROWTYPE;
  v_is_engineer    boolean;
  v_org_id         uuid;
  v_employee_id    uuid;
  v_amount         numeric;
  v_limit          numeric;
  v_profile_count  int;
  v_balance_before numeric;
  v_balance_after  numeric;
  v_deduction_id   uuid;
  v_comment        text := nullif(trim(p_comment), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- (a) Lock the expense first (same lock order as V2: expense -> profile).
  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  v_org_id      := e.organization_id;
  v_employee_id := e.user_id;
  v_amount      := COALESCE(e.total_amount, 0);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Expense is missing organization_id; refusing to deduct';
  END IF;

  -- (b) Terminal expenses are never re-approved (fail fast before any locking).
  IF e.status IN ('approved', 'rejected', 'paid') THEN
    RAISE EXCEPTION 'This expense is already %', e.status;
  END IF;

  -- (c) Override is ENGINEER-ONLY, active, in the expense's own organization.
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = v_org_id
      AND om.role = 'engineer'
      AND om.is_active = true
  ) INTO v_is_engineer;

  IF NOT v_is_engineer THEN
    RAISE EXCEPTION 'Manager override is available to engineers only';
  END IF;

  -- (d) No self-review, ever.
  IF v_uid = v_employee_id THEN
    RAISE EXCEPTION 'You cannot approve your own expense';
  END IF;

  -- (e) Legitimate manager scope over this employee — the SAME check V1 uses.
  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
  END IF;

  -- (f) The engineer approval limit is RETAINED. The override bypasses the tier
  --     gate, NOT the money ceiling.
  SELECT os.engineer_approval_limit INTO v_limit
  FROM public.organization_settings os
  WHERE os.organization_id = v_org_id
  LIMIT 1;

  IF v_limit IS NOT NULL AND v_limit > 0 AND v_amount > v_limit THEN
    RAISE EXCEPTION 'This expense exceeds the manager approval limit.';
  END IF;

  -- (g) Strict employee profile resolution (organization AND user, never LIMIT 1).
  SELECT count(*) INTO v_profile_count
  FROM public.profiles p
  WHERE p.organization_id = v_org_id AND p.user_id = v_employee_id;

  IF v_profile_count = 0 THEN
    RAISE EXCEPTION 'No profile found for this employee in this organization; approval aborted';
  ELSIF v_profile_count > 1 THEN
    RAISE EXCEPTION 'Ambiguous employee profile (% rows) for this organization; approval aborted',
      v_profile_count;
  END IF;

  -- (h) Lock exactly that one profile row.
  SELECT COALESCE(p.balance, 0) INTO v_balance_before
  FROM public.profiles p
  WHERE p.organization_id = v_org_id AND p.user_id = v_employee_id
  FOR UPDATE;

  -- (i) Approve the expense. The tier gate is intentionally overridden HERE and
  --     only here; the audit entry below records that explicitly.
  UPDATE public.expenses
  SET status        = 'approved',
      admin_comment = COALESCE(v_comment, admin_comment),
      approved_by   = v_uid,
      approved_at   = now(),
      updated_at    = now()
  WHERE id = p_expense_id;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
  IF e.status <> 'approved' THEN
    RAISE EXCEPTION 'Approval did not reach approved status (got %)', e.status;
  END IF;
  v_amount := COALESCE(e.total_amount, 0);

  -- (j) Balance arithmetic in SQL against the locked row. Negative balances are
  --     legitimate and must succeed. Identical to review_approve_expense_v2.
  UPDATE public.profiles
  SET balance    = COALESCE(balance, 0) - v_amount,
      updated_at = now()
  WHERE organization_id = v_org_id AND user_id = v_employee_id
  RETURNING balance INTO v_balance_after;

  IF v_balance_after IS NULL THEN
    RAISE EXCEPTION 'Balance update affected no row; approval rolled back';
  END IF;

  -- (k) Structured evidence. UNIQUE(expense_id) is shared with V2, so a double
  --     deduction — by a retry, a concurrent V2 approval, or this override — is a
  --     constraint violation that rolls the whole transaction back.
  INSERT INTO public.expense_balance_deductions (
    organization_id, expense_id, employee_user_id, approved_by,
    expense_amount, balance_before, balance_after, source
  )
  VALUES (
    v_org_id, p_expense_id, v_employee_id, v_uid,
    v_amount, v_balance_before, v_balance_after, 'approval'
  )
  RETURNING id INTO v_deduction_id;

  -- (l) Truthful audit that names the override.
  INSERT INTO public.audit_logs (organization_id, expense_id, user_id, action, comment)
  VALUES (
    v_org_id, p_expense_id, v_uid, 'expense_approved',
    trim(
      COALESCE(v_comment || ' ', '') ||
      'Manager override approval (later-tier gate bypassed by engineer). ' ||
      'Balance deducted: ' || to_char(v_amount, 'FM999999999990.00') ||
      '. Balance before: ' || to_char(v_balance_before, 'FM999999999990.00') || '. ' ||
      CASE WHEN v_balance_after < 0
           THEN 'Negative balance: ' || to_char(abs(v_balance_after), 'FM999999999990.00')
           ELSE 'Remaining balance: ' || to_char(v_balance_after, 'FM999999999990.00')
      END || '.'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'override', true,
    'balance', jsonb_build_object(
      'before',   v_balance_before,
      'deducted', v_amount,
      'after',    v_balance_after
    ),
    'deduction', jsonb_build_object(
      'record_id', v_deduction_id,
      'source',    'approval'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_approve_expense_manager_override_v1(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_approve_expense_manager_override_v1(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_approve_expense_manager_override_v1(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.review_approve_expense_manager_override_v1(uuid, text) IS
  'PREPARED, NOT APPLIED. Engineer-only override to approve an expense still '
  'waiting at a later hierarchy tier, within the engineer''s manager scope. '
  'Overrides ONLY the tier gate; retains org isolation, active membership, no '
  'self-review, non-terminal status, expense_manager_can_review scope and the '
  'engineer_approval_limit ceiling, and reuses review_approve_expense_v2''s '
  'atomic balance deduction (shared expense_balance_deductions UNIQUE per '
  'expense). Executive and Team Leader gain nothing. Frontend keeps this '
  'disabled until a separate explicit authorization applies this migration.';

-- NO `NOTIFY pgrst, 'reload schema';` — this migration is prepared and must not
-- be treated as live.
