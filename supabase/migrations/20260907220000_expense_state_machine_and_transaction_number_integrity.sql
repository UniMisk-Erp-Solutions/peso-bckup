-- ─────────────────────────────────────────────────────────────────────────────
-- PesoWise · Expense state-machine integrity + transaction-number guarantee
--
-- PRIMARY BUG
-- ===========
-- review_approve_expense_manager_override_v1 gated the source status with a
-- DENY-LIST of terminal statuses:
--
--     IF e.status IN ('approved', 'rejected', 'paid') THEN ... END IF;
--
-- 'draft' is not terminal, so a never-submitted expense passed the guard and was
-- written straight to 'approved'. Every other approval/verify path in the system
-- uses an ALLOW-LIST of source statuses and correctly refuses a draft; this
-- function was the only exception, and it is reachable from bulk Manager
-- Override.
--
-- CONSEQUENCE
-- ===========
-- assign_transaction_number only fired on the transition INTO 'submitted', so an
-- expense that skipped that transition reached a protected state with a NULL
-- transaction_number and, being terminal, could never acquire one.
--
-- THIS MIGRATION INSTALLS TWO INDEPENDENT INVARIANTS
-- ==================================================
--   A. An illegal entry into the review workflow cannot commit  (RPC + trigger)
--   B. Any expense in a protected state carries a transaction number (trigger)
--
-- B is deliberately NOT a substitute for A: an illegal draft -> approved is
-- REJECTED, not "approved but numbered".
--
-- SCOPE DISCIPLINE
-- ================
-- No historical row is modified. The 13 legacy approved MicroLink expenses that
-- never had a transaction number are left exactly as they are; DOC-121 records
-- that they were never assigned one rather than having lost one.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. THE CANONICAL RULE — one source of truth, shared by the RPC and the trigger
-- ══════════════════════════════════════════════════════════════════════════════
--
-- This deliberately encodes ONE proven rule rather than a whole re-invented
-- state machine: an expense may not jump from the pre-submission state directly
-- into a protected workflow state. Everything else is left alone, because the
-- existing approval/verify functions already carry their own correct allow-lists
-- and a broader backstop would risk blocking legitimate flows.
--
-- Extend HERE if further transitions are ever proven illegal — never by adding a
-- second, divergent rule elsewhere.
CREATE OR REPLACE FUNCTION public.expense_status_transition_allowed_v1(
  p_from text,
  p_to   text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE
    -- No transition at all (INSERT, or an update that leaves status untouched).
    WHEN p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN true

    -- This rule only governs leaving the pre-submission state.
    WHEN p_from <> 'draft' THEN true

    -- The one legal way a draft enters the workflow.
    WHEN p_to = 'submitted' THEN true

    -- draft -> any other protected state is the bypass this migration closes.
    WHEN public._expense_status_is_protected_v1(p_to) THEN false

    -- draft -> rejected / edited and similar non-protected moves stay legal.
    ELSE true
  END;
$fn$;

COMMENT ON FUNCTION public.expense_status_transition_allowed_v1(text, text) IS
  'Canonical expense status-transition rule. Currently encodes the proven '
  'invariant that a draft may only enter the review workflow via submitted. '
  'Shared by review_approve_expense_manager_override_v1 and the '
  'enforce_expense_status_transition backstop trigger so the two cannot diverge.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. INVARIANT A (part 1) — the RPC that actually caused the incident
-- ══════════════════════════════════════════════════════════════════════════════
-- Reproduced verbatim from 20260810160000_manager_override_approve_prepared.sql,
-- which is byte-identical in logic to the live Production definition, with the
-- single addition of step (b2). Nothing else about override semantics changes:
-- it still bypasses the tier gate, still honours the engineer approval limit,
-- still refuses self-review, still performs the same atomic balance deduction.

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

  -- (b2) THE FIX. The override exists to bypass the TIER gate for an expense
  --      already waiting inside the review pipeline. It must never bypass the
  --      SUBMISSION gate. Before this check the guard above was a deny-list of
  --      terminal statuses only, so 'draft' — which is not terminal — passed
  --      straight through to the approval UPDATE below. That is how expenses
  --      reached 'approved' without ever transitioning through 'submitted',
  --      which in turn is why assign_transaction_number never fired for them.
  --
  --      The rule lives in ONE place, expense_status_transition_allowed_v1, and
  --      is shared with the database backstop trigger so the two can never
  --      diverge.
  IF NOT public.expense_status_transition_allowed_v1(e.status::text, 'approved') THEN
    RAISE EXCEPTION
      'This expense has not been submitted yet (status: %). It cannot be approved.',
      e.status
      USING ERRCODE = 'PW003',
            HINT = 'Ask the employee to submit the expense before approving it.';
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

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. INVARIANT A (part 2) — database backstop
-- ══════════════════════════════════════════════════════════════════════════════
-- Catches the same illegal move arriving by any other route: a future buggy RPC,
-- a direct UPDATE, a careless script. Narrow by construction — it fires only when
-- status actually changes, and only rejects what rule 1 calls illegal.
CREATE OR REPLACE FUNCTION public.trg_enforce_expense_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
     AND NOT public.expense_status_transition_allowed_v1(OLD.status::text, NEW.status::text)
  THEN
    RAISE EXCEPTION
      'Illegal expense status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'PW003',
            HINT = 'An expense must be submitted before it can enter the review workflow.';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS enforce_expense_status_transition ON public.expenses;

-- Named to sort BEFORE trigger_assign_transaction_number so an illegal move is
-- rejected without first consuming a value from the organization's counter.
CREATE TRIGGER enforce_expense_status_transition
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_expense_status_transition();

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. INVARIANT B — a protected expense always carries a transaction number
-- ══════════════════════════════════════════════════════════════════════════════
-- Strictly a SUPERSET of the previous behaviour, so no existing flow can lose a
-- number it used to get:
--
--   before: assign only when entering 'submitted'
--   after : assign when entering ANY protected state without a number
--
-- A draft still legitimately has none, because 'draft' is not protected. So do
-- 'rejected' and 'edited'. The column stays nullable on purpose.
CREATE OR REPLACE FUNCTION public.assign_transaction_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.transaction_number IS NULL
     AND NEW.organization_id IS NOT NULL
     AND public._expense_status_is_protected_v1(NEW.status::text)
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
  THEN
    NEW.transaction_number := public.generate_transaction_number(NEW.organization_id);
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.assign_transaction_number() IS
  'Allocates a transaction number when an expense ENTERS any protected workflow '
  'state without one. Previously fired only on the transition into submitted, '
  'which left expenses that skipped that transition permanently unnumbered.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. INTEGRITY PROBE — protected rows with no transaction number
-- ══════════════════════════════════════════════════════════════════════════════
-- Service-role only: it enumerates rows across every tenant.
CREATE OR REPLACE FUNCTION public.expenses_missing_transaction_number_v1()
RETURNS TABLE(organization_id uuid, expense_id uuid, status text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT e.organization_id, e.id, e.status::text, e.created_at
  FROM public.expenses e
  WHERE e.transaction_number IS NULL
    AND public._expense_status_is_protected_v1(e.status::text)
  ORDER BY e.created_at;
$fn$;

REVOKE ALL ON FUNCTION public.expenses_missing_transaction_number_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expenses_missing_transaction_number_v1() FROM anon;
REVOKE ALL ON FUNCTION public.expenses_missing_transaction_number_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_missing_transaction_number_v1() TO service_role;

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. INSTALL-TIME PROOF — the migration must not change a single business row
-- ══════════════════════════════════════════════════════════════════════════════
DO $verify$
DECLARE
  n_legacy int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'expenses'
                    AND t.tgname = 'enforce_expense_status_transition') THEN
    RAISE EXCEPTION 'state-machine backstop trigger was not installed';
  END IF;

  IF public.expense_status_transition_allowed_v1('draft', 'approved') THEN
    RAISE EXCEPTION 'rule regression: draft -> approved is still considered legal';
  END IF;
  IF public.expense_status_transition_allowed_v1('draft', 'verified') THEN
    RAISE EXCEPTION 'rule regression: draft -> verified is still considered legal';
  END IF;
  IF NOT public.expense_status_transition_allowed_v1('draft', 'submitted') THEN
    RAISE EXCEPTION 'rule regression: draft -> submitted must stay legal';
  END IF;
  IF NOT public.expense_status_transition_allowed_v1('submitted', 'approved') THEN
    RAISE EXCEPTION 'rule regression: submitted -> approved must stay legal';
  END IF;
  IF NOT public.expense_status_transition_allowed_v1('level_2_verified', 'approved') THEN
    RAISE EXCEPTION 'rule regression: level_2_verified -> approved must stay legal';
  END IF;
  IF NOT public.expense_status_transition_allowed_v1('approved', 'paid') THEN
    RAISE EXCEPTION 'rule regression: approved -> paid must stay legal';
  END IF;

  -- The historical rows are explicitly untouched by this migration.
  SELECT count(*) INTO n_legacy
  FROM public.expenses e
  WHERE e.transaction_number IS NULL
    AND public._expense_status_is_protected_v1(e.status::text);
  RAISE NOTICE 'legacy protected rows without a transaction number, left unchanged: %', n_legacy;
END
$verify$;

COMMIT;
