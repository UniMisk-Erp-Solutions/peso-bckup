-- DOC-099 — canonical, server-authoritative manual balance mutation RPCs.
--
-- Replaces the browser-orchestrated addAmountToUser/updateBalance flows in
-- src/pages/Balances.tsx documented as unsafe in
-- Documentations MD/balance-system-and-import-audit.md: uncoordinated
-- sequential UPDATEs from the browser, a racy or entirely-absent rollback,
-- no row locking, no transaction, no server-side amount-conservation check.
--
-- Two functions:
--   balance_add_funds_v1   -- "Add Amount" AND the cashier cash-transfer path.
--                              Consolidated deliberately: a cash-mode add IS a
--                              cashier-to-recipient cash transfer (debit the
--                              actor's own wallet, credit the target, in one
--                              transaction, both rows locked in deterministic
--                              order) -- a second, separately-named RPC for
--                              "cashier cash transfer" would just duplicate
--                              this exact logic. Bank-transfer-mode adds never
--                              touch the actor's own balance (funds are
--                              sourced externally; only the target is
--                              credited), matching the existing product
--                              behavior audited in Balances.tsx.
--   balance_adjust_v1      -- admin-only direct correction (absolute target
--                              balance), requires a reason, no "add amount"
--                              semantics.
--
-- Both follow the locking/evidence pattern proven in
-- review_approve_expense_v2 (DOC-089,
-- 20260808140000_atomic_expense_approval_balance_deduction.sql): lock every
-- profile row about to be mutated FOR UPDATE (in a deterministic order when
-- two rows are involved, to keep concurrent transfers deadlock-free), do the
-- arithmetic in SQL against the locked value, explicitly guard a zero-row
-- UPDATE (the exact "RLS silently filters, PostgREST doesn't error" failure
-- mode that incident documented), write an immutable balance_ledger row in
-- the SAME transaction, and dual-write the legacy money_assignments /
-- cash_transfer_history rows so existing read surfaces (Cashier Transactions,
-- Reports, CSV export, the employee balance-history page) keep working
-- unchanged during the transition (legacy retirement is a separate,
-- later task per the owner's explicit instruction not to destabilize
-- existing surfaces in this same-day feature).
--
-- Authorization uses organization_memberships.role (the modern pattern this
-- whole codebase's financial-critical code already uses -- review_approve_
-- expense_v2, review_verify_batch_atomic_v1), not the legacy, NOT
-- organization-scoped has_role()/user_roles table some older RLS policies on
-- these same tables still reference. That divergence is a pre-existing,
-- out-of-scope risk documented in the audit; every new function here is
-- self-contained and does not depend on has_role() at all.

-- ---------------------------------------------------------------------------
-- 1) balance_add_funds_v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.balance_add_funds_v1(
  p_target_user_id        uuid,
  p_amount                numeric,
  p_payment_mode          text DEFAULT 'cash',
  p_source_bank_account_id uuid DEFAULT NULL,
  p_note                  text DEFAULT NULL,
  p_idempotency_key       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid                 uuid := auth.uid();
  v_org_id               uuid;
  v_caller_role          text;
  v_target_role          text;
  v_note                 text := nullif(trim(p_note), '');
  v_lock_first           uuid;
  v_lock_second          uuid;
  v_actor_balance_before numeric;
  v_actor_balance_after  numeric;
  v_target_balance_before numeric;
  v_target_balance_after numeric;
  v_bank_name            text;
  v_bank_holder          text;
  v_bank_masked          text;
  v_target_name          text;
  v_actor_ledger_id      uuid;
  v_target_ledger_id     uuid;
  v_transfer_type        text;
  v_existing             record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive number';
  END IF;

  IF p_payment_mode NOT IN ('cash', 'bank_transfer') THEN
    RAISE EXCEPTION 'Invalid payment mode: %', p_payment_mode;
  END IF;

  -- (0) Idempotency: if this exact key was already applied for this caller's
  --     org, return the prior result instead of mutating again. Checked
  --     BEFORE any lock is taken.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT bl.id, bl.organization_id INTO v_existing
    FROM public.balance_ledger bl
    WHERE bl.idempotency_key = p_idempotency_key
      AND bl.source_type = 'manual_add'
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true, 'already_applied', true, 'ledger_entry_id', v_existing.id
      );
    END IF;
  END IF;

  -- (1) Caller's organization + role. Must be admin or cashier.
  SELECT om.organization_id, om.role::text INTO v_org_id, v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.is_active = true
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no active organization membership';
  END IF;

  IF v_caller_role NOT IN ('admin', 'cashier') THEN
    RAISE EXCEPTION 'Only admins and cashiers may add funds';
  END IF;

  -- (2) Target must be an active member of the SAME organization. Cross-org
  --     target is denied, never guessed.
  SELECT om.role::text INTO v_target_role
  FROM public.organization_memberships om
  WHERE om.user_id = p_target_user_id
    AND om.organization_id = v_org_id
    AND om.is_active = true;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not an active member of your organization';
  END IF;

  IF p_target_user_id = v_uid THEN
    RAISE EXCEPTION 'Cannot add funds to your own account via this action';
  END IF;

  IF p_payment_mode = 'bank_transfer' AND p_source_bank_account_id IS NOT NULL THEN
    SELECT ba.bank_name, ba.account_holder_name,
           '****' || right(ba.account_number, 4)
    INTO v_bank_name, v_bank_holder, v_bank_masked
    FROM public.organization_bank_accounts ba
    WHERE ba.id = p_source_bank_account_id AND ba.organization_id = v_org_id;

    IF v_bank_name IS NULL THEN
      RAISE EXCEPTION 'Bank account not found in your organization';
    END IF;
  END IF;

  v_transfer_type := CASE v_target_role
    WHEN 'admin' THEN v_caller_role || '_to_admin'
    WHEN 'cashier' THEN v_caller_role || '_to_cashier'
    WHEN 'engineer' THEN v_caller_role || '_to_engineer'
    ELSE v_caller_role || '_to_employee'
  END;

  -- (3) Lock rows FOR UPDATE in a DETERMINISTIC order (smaller uuid first) so
  --     two concurrent transfers touching an overlapping pair of users can
  --     never deadlock against each other.
  IF p_payment_mode = 'cash' THEN
    IF v_uid < p_target_user_id THEN
      v_lock_first := v_uid; v_lock_second := p_target_user_id;
    ELSE
      v_lock_first := p_target_user_id; v_lock_second := v_uid;
    END IF;

    PERFORM 1 FROM public.profiles WHERE user_id = v_lock_first FOR UPDATE;
    PERFORM 1 FROM public.profiles WHERE user_id = v_lock_second FOR UPDATE;

    SELECT COALESCE(balance, 0) INTO v_actor_balance_before
    FROM public.profiles WHERE user_id = v_uid AND organization_id = v_org_id;

    IF v_actor_balance_before IS NULL THEN
      RAISE EXCEPTION 'Your profile could not be found in this organization';
    END IF;

    IF v_actor_balance_before < p_amount THEN
      RAISE EXCEPTION 'Insufficient balance: you have %, tried to send %',
        v_actor_balance_before, p_amount;
    END IF;

    -- (4a) Debit the actor's own wallet.
    UPDATE public.profiles
    SET balance = COALESCE(balance, 0) - p_amount, updated_at = now()
    WHERE user_id = v_uid AND organization_id = v_org_id
    RETURNING balance INTO v_actor_balance_after;

    IF v_actor_balance_after IS NULL THEN
      RAISE EXCEPTION 'Balance update affected no row; transfer rolled back (actor)';
    END IF;
  ELSE
    -- Bank-transfer mode: only lock the target row; the actor's tracked
    -- wallet is never touched (funds are sourced from the bank account).
    PERFORM 1 FROM public.profiles WHERE user_id = p_target_user_id FOR UPDATE;
  END IF;

  -- (4b) Credit the target, against the now-locked row.
  SELECT COALESCE(balance, 0) INTO v_target_balance_before
  FROM public.profiles WHERE user_id = p_target_user_id AND organization_id = v_org_id;

  UPDATE public.profiles
  SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_target_user_id AND organization_id = v_org_id
  RETURNING balance, name INTO v_target_balance_after, v_target_name;

  IF v_target_balance_after IS NULL THEN
    RAISE EXCEPTION 'Balance update affected no row; transfer rolled back (target)';
  END IF;

  -- (5) Immutable ledger evidence, same transaction.
  IF p_payment_mode = 'cash' THEN
    INSERT INTO public.balance_ledger (
      organization_id, user_id, amount_delta, balance_before, balance_after,
      entry_type, source_type, actor_user_id, note, idempotency_key
    ) VALUES (
      v_org_id, v_uid, -p_amount, v_actor_balance_before, v_actor_balance_after,
      'cash_transfer_out', 'manual_add', v_uid, v_note,
      CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key || ':out' END
    ) RETURNING id INTO v_actor_ledger_id;
  END IF;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, source_id, actor_user_id, note, idempotency_key
  ) VALUES (
    v_org_id, p_target_user_id, p_amount, v_target_balance_before, v_target_balance_after,
    CASE WHEN p_payment_mode = 'cash' THEN 'cash_transfer_in' ELSE 'allocation' END,
    'manual_add', v_actor_ledger_id, v_uid, v_note, p_idempotency_key
  ) RETURNING id INTO v_target_ledger_id;

  -- (6) Legacy compatibility rows -- same transaction, so a failure here
  --     rolls back the balance change too rather than leaving the ledger
  --     ahead of what old readers can see.
  IF v_caller_role IN ('admin', 'cashier') THEN
    INSERT INTO public.cash_transfer_history (
      organization_id, transferrer_id, transferrer_role, recipient_id, recipient_role,
      amount, transfer_type, payment_mode, source_bank_account_id,
      source_bank_name_snapshot, source_account_holder_snapshot,
      source_account_number_masked_snapshot, notes
    ) VALUES (
      v_org_id, v_uid, v_caller_role, p_target_user_id, v_target_role,
      p_amount, v_transfer_type, p_payment_mode, p_source_bank_account_id,
      v_bank_name, v_bank_holder, v_bank_masked, v_note
    );
  END IF;

  IF v_caller_role = 'cashier' AND v_target_role IN ('employee', 'engineer') THEN
    INSERT INTO public.money_assignments (cashier_id, recipient_id, amount, organization_id)
    VALUES (v_uid, p_target_user_id, p_amount, v_org_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'target_user_id', p_target_user_id,
    'target_name', v_target_name,
    'amount', p_amount,
    'payment_mode', p_payment_mode,
    'actor_balance_after', v_actor_balance_after,
    'target_balance_after', v_target_balance_after,
    'ledger_entry_id', v_target_ledger_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_add_funds_v1(uuid, numeric, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_add_funds_v1(uuid, numeric, text, uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_add_funds_v1(uuid, numeric, text, uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.balance_add_funds_v1(uuid, numeric, text, uuid, text, text) IS
  'DOC-099. Server-authoritative replacement for Balances.tsx addAmountToUser. '
  'Cash mode debits the caller''s own wallet and credits the target in one '
  'transaction with both profile rows locked FOR UPDATE in deterministic '
  'order (this is also the atomic cashier-cash-transfer path -- a separate '
  'RPC would only duplicate this logic). Bank-transfer mode credits the '
  'target only. Writes an immutable balance_ledger row plus legacy '
  'cash_transfer_history/money_assignments compatibility rows in the same '
  'transaction. Idempotent when p_idempotency_key is supplied.';

-- ---------------------------------------------------------------------------
-- 2) balance_adjust_v1 -- admin-only direct correction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.balance_adjust_v1(
  p_target_user_id  uuid,
  p_new_balance     numeric,
  p_reason          text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_org_id           uuid;
  v_caller_role      text;
  v_target_role      text;
  v_balance_before   numeric;
  v_balance_after    numeric;
  v_delta            numeric;
  v_reason           text := nullif(trim(p_reason), '');
  v_ledger_id        uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_new_balance IS NULL THEN
    RAISE EXCEPTION 'A target balance is required';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason/note is required for a direct balance correction';
  END IF;

  -- Admin-only. Cashiers use balance_add_funds_v1; direct SET is an
  -- admin-only correction tool by design (the existing UI already scopes
  -- the Edit-balance dialog to admin -- this enforces it server-side too).
  SELECT om.organization_id, om.role::text INTO v_org_id, v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.is_active = true
  LIMIT 1;

  IF v_org_id IS NULL OR v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may directly correct a balance';
  END IF;

  SELECT om.role::text INTO v_target_role
  FROM public.organization_memberships om
  WHERE om.user_id = p_target_user_id
    AND om.organization_id = v_org_id
    AND om.is_active = true;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not an active member of your organization';
  END IF;

  PERFORM 1 FROM public.profiles WHERE user_id = p_target_user_id FOR UPDATE;

  SELECT COALESCE(balance, 0) INTO v_balance_before
  FROM public.profiles WHERE user_id = p_target_user_id AND organization_id = v_org_id;

  v_delta := p_new_balance - v_balance_before;

  IF v_delta = 0 THEN
    RETURN jsonb_build_object(
      'ok', true, 'no_op', true, 'balance', v_balance_before
    );
  END IF;

  UPDATE public.profiles
  SET balance = p_new_balance, updated_at = now()
  WHERE user_id = p_target_user_id AND organization_id = v_org_id
  RETURNING balance INTO v_balance_after;

  IF v_balance_after IS NULL THEN
    RAISE EXCEPTION 'Balance update affected no row; correction rolled back';
  END IF;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, actor_user_id, note
  ) VALUES (
    v_org_id, p_target_user_id, v_delta, v_balance_before, v_balance_after,
    'manual_adjustment', 'manual_adjust', v_uid, v_reason
  ) RETURNING id INTO v_ledger_id;

  -- Legacy history only logged an upward correction historically; preserve
  -- that behavior for compatibility (a downward correction is still fully
  -- captured in balance_ledger regardless).
  IF v_delta > 0 THEN
    INSERT INTO public.cash_transfer_history (
      organization_id, transferrer_id, transferrer_role, recipient_id, recipient_role,
      amount, transfer_type, payment_mode, notes
    ) VALUES (
      v_org_id, v_uid, 'admin', p_target_user_id, v_target_role,
      v_delta, 'admin_to_' || v_target_role, 'cash', v_reason
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'target_user_id', p_target_user_id,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after,
    'delta', v_delta,
    'ledger_entry_id', v_ledger_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_adjust_v1(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_adjust_v1(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_adjust_v1(uuid, numeric, text) TO authenticated;

COMMENT ON FUNCTION public.balance_adjust_v1(uuid, numeric, text) IS
  'DOC-099. Server-authoritative replacement for Balances.tsx updateBalance. '
  'Admin-only, requires a reason. Locks the target profile row FOR UPDATE, '
  'sets balance to the exact requested value, writes an immutable '
  'balance_ledger row (manual_adjustment) in the same transaction.';

NOTIFY pgrst, 'reload schema';
