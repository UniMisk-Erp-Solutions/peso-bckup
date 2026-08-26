-- DOC-099 — financial path closure pass, corrective migration #3.
--
-- propose_balance_transfer_offer / accept_balance_transfer_offer predate
-- this session's SSH-applied migration set (080608_1430) and are owned by a
-- different Postgres role than the one this session's DDL channel connects
-- as -- CREATE OR REPLACE on those exact names fails with
-- "must be owner of function". Rather than attempt a privilege-escalation
-- workaround, this ships the corrected logic as NEW, freshly-owned
-- functions -- propose_balance_transfer_offer_v2 /
-- accept_balance_transfer_offer_v2 -- matching this codebase's own
-- established _v2 convention (review_approve_expense_v2,
-- balance_add_funds_v1, etc). BalanceTransferOfferService.ts is repointed to
-- call these v2 names exclusively. The old propose_balance_transfer_offer /
-- accept_balance_transfer_offer remain present server-side (their EXECUTE
-- grant could not be revoked for the same ownership reason) but are no
-- longer called by any sanctioned application path -- see the final report
-- for this documented, transparent limitation.
--
-- propose_balance_transfer_offer_v2: cashier target scope now delegates to
-- the shared public._cashier_target_authorized_v1 helper (location-priority,
-- engineer-fallback) instead of the old function's engineer-only copy, so UI
-- direct Add and transfer-offer proposal can never diverge.
-- is_accountant_cashier read-only gate and every other existing check
-- (self-offer, cross-org recipient, cashier->admin denial, cash pre-check,
-- bank account existence/is_active) are preserved unchanged.
--
-- accept_balance_transfer_offer_v2: the old function read profile balances
-- with a plain SELECT (no FOR UPDATE) and SET a calculated value -- a
-- lost-update race under concurrent acceptance -- and never wrote
-- balance_ledger at all. This locks the offer, re-verifies recipient/status,
-- re-verifies both parties are still active org members, locks the affected
-- profile row(s) in deterministic order, re-reads balances only after the
-- locks, does the arithmetic server-side, and writes balance_ledger evidence
-- (source_type 'bank_transfer_offer', source_id = offer.id) in the SAME
-- transaction as the balance UPDATE(s), cash_transfer_history,
-- money_assignments, and the offer's own status transition. Zero partial
-- acceptance.

CREATE OR REPLACE FUNCTION public.propose_balance_transfer_offer_v2(
  p_organization_id UUID,
  p_recipient_id UUID,
  p_amount DECIMAL,
  p_payment_mode TEXT DEFAULT 'cash',
  p_source_bank_account_id UUID DEFAULT NULL,
  p_note TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_transferrer_role TEXT;
  v_recipient_role TEXT;
  v_transfer_type TEXT;
  v_cashier_balance DECIMAL(10, 2);
  v_bank RECORD;
  v_bank_name_snapshot TEXT;
  v_bank_holder_snapshot TEXT;
  v_bank_number_masked_snapshot TEXT;
  v_source_bank_id UUID;
  v_offer_id UUID;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF public.is_accountant_cashier(v_caller, p_organization_id) THEN
    RAISE EXCEPTION 'Accountant cashiers have read-only access';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  IF p_payment_mode NOT IN ('cash', 'bank_transfer') THEN
    RAISE EXCEPTION 'Invalid payment mode';
  END IF;

  v_transferrer_role := public._primary_org_role(v_caller, p_organization_id);
  IF v_transferrer_role IS NULL OR v_transferrer_role NOT IN ('admin', 'cashier') THEN
    RAISE EXCEPTION 'Only administrators or cashiers can propose transfer offers';
  END IF;

  IF p_recipient_id = v_caller THEN
    RAISE EXCEPTION 'Cannot send a transfer offer to yourself';
  END IF;

  v_recipient_role := public._primary_org_role(p_recipient_id, p_organization_id);
  IF v_recipient_role IS NULL THEN
    RAISE EXCEPTION 'Recipient is not an active member of this organization';
  END IF;

  IF v_transferrer_role = 'cashier' AND v_recipient_role = 'admin' THEN
    RAISE EXCEPTION 'Cashiers cannot send transfer offers to administrators';
  END IF;

  IF v_transferrer_role = 'cashier' THEN
    IF v_recipient_role <> 'cashier'
      AND NOT public._cashier_target_authorized_v1(v_caller, p_organization_id, p_recipient_id, v_recipient_role)
    THEN
      RAISE EXCEPTION 'You are not authorized to send offers to this recipient';
    END IF;

    IF p_payment_mode = 'cash' THEN
      SELECT COALESCE(balance, 0) INTO v_cashier_balance
      FROM public.profiles WHERE user_id = v_caller;
      IF v_cashier_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient cashier balance for this offer';
      END IF;
    END IF;
  END IF;

  v_source_bank_id := NULL;
  v_bank_name_snapshot := NULL;
  v_bank_holder_snapshot := NULL;
  v_bank_number_masked_snapshot := NULL;

  IF p_payment_mode = 'bank_transfer' THEN
    IF p_source_bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Source bank account is required for bank transfer offers';
    END IF;
    SELECT ba.bank_name, ba.account_holder_name, ba.account_number, ba.is_active
    INTO v_bank
    FROM public.organization_bank_accounts ba
    WHERE ba.id = p_source_bank_account_id
      AND ba.organization_id = p_organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid or inactive source bank account';
    END IF;
    IF v_bank.is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Invalid or inactive source bank account';
    END IF;
    v_source_bank_id := p_source_bank_account_id;
    v_bank_name_snapshot := v_bank.bank_name;
    v_bank_holder_snapshot := v_bank.account_holder_name;
    v_bank_number_masked_snapshot := public._mask_bank_account_number(v_bank.account_number);
  END IF;

  v_transfer_type := public._resolve_outbound_transfer_type(v_transferrer_role, v_recipient_role);

  INSERT INTO public.balance_transfer_offers (
    organization_id, transferrer_id, transferrer_role, recipient_id, recipient_role,
    amount, status, payment_mode, source_bank_account_id,
    source_bank_name_snapshot, source_account_holder_snapshot,
    source_account_number_masked_snapshot, transfer_type, note
  ) VALUES (
    p_organization_id, v_caller, v_transferrer_role, p_recipient_id, v_recipient_role,
    p_amount, 'pending', p_payment_mode, v_source_bank_id,
    v_bank_name_snapshot, v_bank_holder_snapshot, v_bank_number_masked_snapshot,
    v_transfer_type, NULLIF(trim(p_note), '')
  )
  RETURNING id INTO v_offer_id;

  RETURN v_offer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_balance_transfer_offer_v2(p_offer_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  offer public.balance_transfer_offers%ROWTYPE;
  v_debit_transferrer BOOLEAN;
  v_lock_first UUID;
  v_lock_second UUID;
  v_recipient_balance_before DECIMAL(10, 2);
  v_recipient_balance_after DECIMAL(10, 2);
  v_transferrer_balance_before DECIMAL(10, 2);
  v_transferrer_balance_after DECIMAL(10, 2);
  v_transferrer_ledger_id UUID;
  v_history_recipient_role TEXT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO offer
  FROM public.balance_transfer_offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer offer not found';
  END IF;

  IF offer.status <> 'pending' THEN
    RAISE EXCEPTION 'Transfer offer is no longer pending';
  END IF;

  IF offer.recipient_id <> v_caller THEN
    RAISE EXCEPTION 'Only the recipient can accept this offer';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = offer.recipient_id
      AND om.organization_id = offer.organization_id
      AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'You are no longer an active member of this organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = offer.transferrer_id
      AND om.organization_id = offer.organization_id
      AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'The sender is no longer an active member of this organization';
  END IF;

  -- Only a cashier's cash-mode offer moves money out of a tracked wallet
  -- (admin cash and every bank_transfer offer credit the recipient from an
  -- untracked/external source, matching balance_add_funds_v1's own rule).
  v_debit_transferrer := (offer.transferrer_role = 'cashier' AND offer.payment_mode = 'cash');

  IF v_debit_transferrer THEN
    IF offer.transferrer_id < offer.recipient_id THEN
      v_lock_first := offer.transferrer_id; v_lock_second := offer.recipient_id;
    ELSE
      v_lock_first := offer.recipient_id; v_lock_second := offer.transferrer_id;
    END IF;
    PERFORM 1 FROM public.profiles WHERE user_id = v_lock_first FOR UPDATE;
    PERFORM 1 FROM public.profiles WHERE user_id = v_lock_second FOR UPDATE;

    SELECT COALESCE(balance, 0) INTO v_transferrer_balance_before
    FROM public.profiles WHERE user_id = offer.transferrer_id;

    IF v_transferrer_balance_before < offer.amount THEN
      RAISE EXCEPTION 'Sender has insufficient balance to complete this transfer';
    END IF;

    UPDATE public.profiles
    SET balance = COALESCE(balance, 0) - offer.amount, updated_at = now()
    WHERE user_id = offer.transferrer_id
    RETURNING balance INTO v_transferrer_balance_after;
  ELSE
    PERFORM 1 FROM public.profiles WHERE user_id = offer.recipient_id FOR UPDATE;
  END IF;

  SELECT COALESCE(balance, 0) INTO v_recipient_balance_before
  FROM public.profiles WHERE user_id = offer.recipient_id;

  UPDATE public.profiles
  SET balance = COALESCE(balance, 0) + offer.amount, updated_at = now()
  WHERE user_id = offer.recipient_id
  RETURNING balance INTO v_recipient_balance_after;

  IF v_recipient_balance_after IS NULL THEN
    RAISE EXCEPTION 'Balance update affected no row; acceptance rolled back (recipient)';
  END IF;

  IF v_debit_transferrer THEN
    INSERT INTO public.balance_ledger (
      organization_id, user_id, amount_delta, balance_before, balance_after,
      entry_type, source_type, source_id, actor_user_id, note
    ) VALUES (
      offer.organization_id, offer.transferrer_id, -offer.amount,
      v_transferrer_balance_before, v_transferrer_balance_after,
      'cash_transfer_out', 'bank_transfer_offer', offer.id, v_caller, offer.note
    ) RETURNING id INTO v_transferrer_ledger_id;
  END IF;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, source_id, actor_user_id, note
  ) VALUES (
    offer.organization_id, offer.recipient_id, offer.amount,
    v_recipient_balance_before, v_recipient_balance_after,
    CASE WHEN offer.payment_mode = 'cash' THEN 'cash_transfer_in' ELSE 'allocation' END,
    'bank_transfer_offer', offer.id, v_caller, offer.note
  );

  IF offer.transferrer_role = 'cashier'
    AND offer.recipient_role IN ('employee', 'engineer', 'team_leader', 'executive') THEN
    INSERT INTO public.money_assignments (cashier_id, recipient_id, amount, organization_id)
    VALUES (offer.transferrer_id, offer.recipient_id, offer.amount, offer.organization_id);
  END IF;

  v_history_recipient_role := public._legacy_transfer_history_role_v1(offer.recipient_role);

  INSERT INTO public.cash_transfer_history (
    organization_id, transferrer_id, transferrer_role, recipient_id, recipient_role,
    amount, transfer_type, payment_mode, source_bank_account_id,
    source_bank_name_snapshot, source_account_holder_snapshot,
    source_account_number_masked_snapshot, notes, transferred_at
  ) VALUES (
    offer.organization_id, offer.transferrer_id, offer.transferrer_role,
    offer.recipient_id, v_history_recipient_role,
    offer.amount, offer.transfer_type, offer.payment_mode, offer.source_bank_account_id,
    offer.source_bank_name_snapshot, offer.source_account_holder_snapshot,
    offer.source_account_number_masked_snapshot, offer.note, NOW()
  );

  UPDATE public.balance_transfer_offers
  SET
    status = 'accepted',
    responded_at = NOW(),
    responded_by = v_caller,
    updated_at = NOW()
  WHERE id = offer.id;
END;
$$;

REVOKE ALL ON FUNCTION public.propose_balance_transfer_offer_v2(uuid, uuid, decimal, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.propose_balance_transfer_offer_v2(uuid, uuid, decimal, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.propose_balance_transfer_offer_v2(uuid, uuid, decimal, text, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.accept_balance_transfer_offer_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_balance_transfer_offer_v2(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_balance_transfer_offer_v2(uuid) TO authenticated;

COMMENT ON FUNCTION public.propose_balance_transfer_offer_v2(uuid, uuid, decimal, text, uuid, text) IS
  'DOC-099. Replaces propose_balance_transfer_offer (kept for compatibility, '
  'no longer called by the app). Cashier target scope now via the shared '
  '_cashier_target_authorized_v1 helper (location-priority, engineer-fallback), '
  'matching balance_add_funds_v1 exactly. is_accountant_cashier read-only gate '
  'preserved.';
COMMENT ON FUNCTION public.accept_balance_transfer_offer_v2(uuid) IS
  'DOC-099. Replaces accept_balance_transfer_offer (kept for compatibility, '
  'no longer called by the app). Locks the offer and the affected profile '
  'row(s) FOR UPDATE in deterministic order, re-verifies both parties are '
  'still active org members, re-reads balances only after locking, and '
  'writes balance_ledger evidence (source_type=bank_transfer_offer) in the '
  'same transaction as the balance UPDATE(s), cash_transfer_history, and '
  'money_assignments. No partial acceptance, no lost-update race.';

NOTIFY pgrst, 'reload schema';
