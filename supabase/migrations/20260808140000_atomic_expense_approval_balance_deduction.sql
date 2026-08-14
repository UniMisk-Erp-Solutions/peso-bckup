-- DOC-089 — atomic expense approval + balance deduction (review_approve_expense_v2)
--
-- CONFIRMED PRODUCTION INCIDENT
-- Expense approval and balance deduction sat on opposite sides of a trust
-- boundary. public.review_approve_expense (V1) approves the expense server-side
-- but never touches profiles.balance; the browser then performed
--   profiles.update({balance: currentBalance - amount}).eq('user_id', ...)
-- Engineers have NO UPDATE policy on public.profiles, so for every engineer
-- approval that write matched zero rows. PostgREST does not raise an error for
-- an RLS-filtered zero-row UPDATE, so the client's failure branch never ran:
-- the expense committed as approved and the balance never moved.
--
-- This migration is ADDITIVE ONLY.
--   * V1 is NOT modified and NOT dropped. A cached client still calling V1 must
--     keep behaving exactly as before, otherwise a stale frontend would deduct
--     twice (server + its own browser write). V1 retirement is a later task.
--   * No historical balance is repaired here. The known MicroLink scope
--     (6 approved expenses, Rs 880, 3 employees) is left untouched for a
--     separate controlled server task.
--   * No expense row is modified. No profile balance is modified.

-- ---------------------------------------------------------------------------
-- 1) Structured financial evidence
-- ---------------------------------------------------------------------------
-- No suitable table existed: a repository-wide search for deduction / debit /
-- ledger structures found only cashier balance-update RLS, which is the
-- unrelated credit/allocation path. cash_transfer_history is deliberately NOT
-- reused — transfers are credit events, expense approval is a debit, and
-- conflating them would corrupt the transfer-history feature.

CREATE TABLE IF NOT EXISTS public.expense_balance_deductions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  expense_id        uuid        NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  employee_user_id  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  approved_by       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expense_amount    numeric     NOT NULL,
  balance_before    numeric     NOT NULL,
  balance_after     numeric     NOT NULL,
  source            text        NOT NULL DEFAULT 'approval',
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- One deduction per expense, forever. This is the structural guarantee that
  -- an expense cannot be debited twice — by a retry, a concurrent approval, or
  -- the future historical repair.
  CONSTRAINT expense_balance_deductions_expense_key UNIQUE (expense_id),
  CONSTRAINT expense_balance_deductions_source_check
    CHECK (source IN ('approval', 'historical_repair'))
);

CREATE INDEX IF NOT EXISTS expense_balance_deductions_org_created_idx
  ON public.expense_balance_deductions (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS expense_balance_deductions_employee_idx
  ON public.expense_balance_deductions (employee_user_id, created_at DESC);

COMMENT ON TABLE public.expense_balance_deductions IS
  'Server-owned financial evidence: one row per expense whose amount was debited '
  'from an employee balance. Written only by SECURITY DEFINER functions. '
  'UNIQUE(expense_id) makes double deduction structurally impossible.';
COMMENT ON COLUMN public.expense_balance_deductions.source IS
  '''approval'' = written by review_approve_expense_v2. ''historical_repair'' = '
  'reserved for the controlled repair of pre-fix approvals; none exist yet.';

-- Server-owned evidence. RLS is enabled with NO permissive policy for writes:
-- the SECURITY DEFINER function is the only writer. A narrow read policy lets
-- admins audit their own organization; employees are not given direct access.
ALTER TABLE public.expense_balance_deductions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read org deductions" ON public.expense_balance_deductions;
CREATE POLICY "Admins read org deductions"
  ON public.expense_balance_deductions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_balance_deductions.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

REVOKE ALL ON TABLE public.expense_balance_deductions FROM PUBLIC;
REVOKE ALL ON TABLE public.expense_balance_deductions FROM anon;
-- SELECT only, and even that is narrowed by the policy above.
GRANT SELECT ON TABLE public.expense_balance_deductions TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) review_approve_expense_v2 — approval and deduction in ONE transaction
-- ---------------------------------------------------------------------------
-- search_path is pinned to `public`, matching V1 and every other SECURITY
-- DEFINER function in this repository, and all object references are fully
-- qualified anyway. (`SET search_path = ''` would be marginally stricter, but
-- this function cannot be executed against a database from the authoring
-- environment, so matching the convention that is already proven in production
-- is the lower-risk choice.)
--
-- V1 is CALLED, not copied. Every authorization rule — admin/engineer roles,
-- organization isolation, hierarchy tier gating, expense_manager_can_review,
-- engineer_approval_limit, allowed source statuses, duplicate-approval
-- rejection and the admin auto-verify step — therefore keeps exactly one
-- implementation and cannot drift. A nested function call runs inside the same
-- transaction, so if the deduction fails afterwards the approval rolls back too.

CREATE OR REPLACE FUNCTION public.review_approve_expense_v2(
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
  v_uid             uuid := auth.uid();
  e                 public.expenses%ROWTYPE;
  v_profile_count   int;
  v_balance_before  numeric;
  v_balance_after   numeric;
  v_amount          numeric;
  v_org_id          uuid;
  v_employee_id     uuid;
  v_prev_status     text;
  v_is_admin        boolean;
  v_auto_verified   boolean;
  v_v1              jsonb;
  v_expense_after   jsonb;
  v_deduction_id    uuid;
  v_comment         text := nullif(trim(p_comment), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- (a) Lock the expense FIRST. Consistent lock ordering (expense -> profile)
  --     across every caller is what keeps concurrent approvals deadlock-free.
  SELECT * INTO e
  FROM public.expenses
  WHERE id = p_expense_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  -- Fail fast on re-approval before any locking or arithmetic. V1 enforces this
  -- too; duplicating it here keeps the error identical and avoids a pointless
  -- profile lock.
  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'This expense is already approved';
  END IF;

  v_org_id      := e.organization_id;
  v_employee_id := e.user_id;
  v_prev_status := e.status::text;
  v_amount      := COALESCE(e.total_amount, 0);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Expense is missing organization_id; refusing to deduct';
  END IF;

  -- (b) Strict employee profile resolution: organization AND user, never
  --     user_id alone, and never LIMIT 1. Financial ambiguity must fail closed.
  SELECT count(*) INTO v_profile_count
  FROM public.profiles p
  WHERE p.organization_id = v_org_id
    AND p.user_id = v_employee_id;

  IF v_profile_count = 0 THEN
    RAISE EXCEPTION
      'No profile found for this employee in this organization; approval aborted';
  ELSIF v_profile_count > 1 THEN
    RAISE EXCEPTION
      'Ambiguous employee profile (% rows) for this organization; approval aborted',
      v_profile_count;
  END IF;

  -- (c) Lock exactly that one profile row — not the whole organization. This is
  --     what serialises several different expenses of the SAME employee being
  --     approved at the same time.
  SELECT COALESCE(p.balance, 0) INTO v_balance_before
  FROM public.profiles p
  WHERE p.organization_id = v_org_id
    AND p.user_id = v_employee_id
  FOR UPDATE;

  -- (d) Delegate the entire approval decision to V1, inside this transaction.
  v_v1 := public.review_approve_expense(p_expense_id, p_comment);

  IF v_v1 IS NULL OR COALESCE((v_v1->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Approval failed';
  END IF;

  -- Re-read the row V1 committed; never trust pre-approval state for money.
  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
  IF e.status <> 'approved' THEN
    RAISE EXCEPTION 'Approval did not reach approved status (got %)', e.status;
  END IF;
  v_amount := COALESCE(e.total_amount, 0);

  -- (e) The arithmetic happens in PostgreSQL, against the locked row.
  --     Negative balances are legitimate and must succeed.
  UPDATE public.profiles
  SET balance    = COALESCE(balance, 0) - v_amount,
      updated_at = now()
  WHERE organization_id = v_org_id
    AND user_id = v_employee_id
  RETURNING balance INTO v_balance_after;

  IF v_balance_after IS NULL THEN
    -- Unreachable given (b)/(c), but a silent zero-row UPDATE is the exact
    -- failure that caused this incident. Never let it pass again.
    RAISE EXCEPTION 'Balance update affected no row; approval rolled back';
  END IF;

  -- (f) Structured evidence. UNIQUE(expense_id) turns any double-deduction
  --     attempt into a constraint violation that rolls the whole thing back.
  INSERT INTO public.expense_balance_deductions (
    organization_id, expense_id, employee_user_id, approved_by,
    expense_amount, balance_before, balance_after, source
  )
  VALUES (
    v_org_id, p_expense_id, v_employee_id, v_uid,
    v_amount, v_balance_before, v_balance_after, 'approval'
  )
  RETURNING id INTO v_deduction_id;

  -- (g) Truthful audit, built from what the database actually committed.
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = v_org_id
      AND om.role = 'admin'
      AND om.is_active = true
  ) INTO v_is_admin;

  -- Admin approval of a submitted/adjusted expense implies auto-verification.
  -- Computed from the PRE-approval status, so it is true only when a verify
  -- step actually happened.
  v_auto_verified := v_is_admin AND v_prev_status IN ('submitted', 'edited');

  IF v_auto_verified THEN
    INSERT INTO public.audit_logs (organization_id, expense_id, user_id, action, comment)
    VALUES (v_org_id, p_expense_id, v_uid, 'expense_verified',
            'Auto-verified by admin during approval');
  END IF;

  INSERT INTO public.audit_logs (organization_id, expense_id, user_id, action, comment)
  VALUES (
    v_org_id, p_expense_id, v_uid, 'expense_approved',
    trim(
      COALESCE(v_comment || ' ', '') ||
      'Balance deducted: ' || to_char(v_amount, 'FM999999999990.00') ||
      '. Balance before: ' || to_char(v_balance_before, 'FM999999999990.00') ||
      '. ' ||
      CASE WHEN v_balance_after < 0
           THEN 'Negative balance: ' || to_char(abs(v_balance_after), 'FM999999999990.00')
           ELSE 'Remaining balance: ' || to_char(v_balance_after, 'FM999999999990.00')
      END || '.'
    )
  );

  SELECT to_jsonb(ex) INTO v_expense_after
  FROM public.expenses ex WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_expense_after,
    'comment', v_comment,
    'auto_verified', v_auto_verified,
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

REVOKE ALL ON FUNCTION public.review_approve_expense_v2(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_approve_expense_v2(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_approve_expense_v2(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.review_approve_expense_v2(uuid, text) IS
  'Atomic expense approval + employee balance deduction. Locks the expense then '
  'the single matching profile (organization_id AND user_id, never LIMIT 1), '
  'delegates all authorization to review_approve_expense (V1) inside the same '
  'transaction, performs the balance arithmetic in SQL, writes structured '
  'evidence to expense_balance_deductions (UNIQUE per expense) and a truthful '
  'audit_logs entry. Takes no approver, employee, organization, amount or role '
  'argument: everything is derived from auth.uid() and the expense row.';

NOTIFY pgrst, 'reload schema';
