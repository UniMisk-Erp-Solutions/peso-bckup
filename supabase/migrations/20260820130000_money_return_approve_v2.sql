-- DOC-099 — financial path closure pass, corrective migration #4.
-- New additive migration; 20260819160000 (balance_ledger) is not edited in
-- place, only ALTERed additively (widen a CHECK constraint, same pattern as
-- any other additive schema change in this project).
--
-- MoneyReturnService.approveReturnRequest was the last fully browser-
-- orchestrated financial mutation on the feature branch: the client read
-- both balances, computed both new values, PATCHed profiles twice with a
-- manual best-effort rollback on the second PATCH's failure, and never wrote
-- balance_ledger. Replaced with one atomic RPC.

-- IF EXISTS added on import into peso-bckup: without it, any re-run after a
-- mid-sequence failure aborts here instead of being a no-op.
ALTER TABLE public.balance_ledger DROP CONSTRAINT IF EXISTS balance_ledger_source_type_check;
ALTER TABLE public.balance_ledger ADD CONSTRAINT balance_ledger_source_type_check
  CHECK (source_type IN (
    'manual_add',
    'manual_adjust',
    'cashier_transfer',
    'bank_transfer_offer',
    'import_batch',
    'expense_approval',
    'reversal',
    'money_return'
  ));

CREATE OR REPLACE FUNCTION public.approve_money_return_request_v2(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid                     uuid := auth.uid();
  v_request                 public.money_return_requests%ROWTYPE;
  v_org_id                  uuid;
  v_requester_role          text;
  v_cashier_role            text;
  v_lock_first              uuid;
  v_lock_second             uuid;
  v_requester_balance_before numeric;
  v_requester_balance_after  numeric;
  v_cashier_balance_before   numeric;
  v_cashier_balance_after    numeric;
  v_requester_ledger_id      uuid;
  v_cashier_ledger_id        uuid;
  v_history_requester_role   text;
  v_transfer_type            text;
  v_remaining                numeric;
  v_assignment               record;
  v_take                     numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_request
  FROM public.money_return_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return request not found';
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'Return request is no longer pending';
  END IF;

  IF v_request.cashier_id <> v_uid THEN
    RAISE EXCEPTION 'Only the assigned cashier can approve this request';
  END IF;

  v_org_id := v_request.organization_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Return request has no organization -- cannot process';
  END IF;

  SELECT om.role::text INTO v_cashier_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_org_id AND om.is_active = true;

  IF v_cashier_role IS NULL OR v_cashier_role NOT IN ('cashier', 'admin') THEN
    RAISE EXCEPTION 'You are not an active cashier or admin in this organization';
  END IF;

  SELECT om.role::text INTO v_requester_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_request.requester_id AND om.organization_id = v_org_id AND om.is_active = true;

  IF v_requester_role IS NULL THEN
    RAISE EXCEPTION 'Requester is not an active member of this organization';
  END IF;

  IF v_request.amount IS NULL OR v_request.amount <= 0 THEN
    RAISE EXCEPTION 'Return request has an invalid amount';
  END IF;

  IF v_request.requester_id < v_uid THEN
    v_lock_first := v_request.requester_id; v_lock_second := v_uid;
  ELSE
    v_lock_first := v_uid; v_lock_second := v_request.requester_id;
  END IF;
  PERFORM 1 FROM public.profiles WHERE user_id = v_lock_first FOR UPDATE;
  PERFORM 1 FROM public.profiles WHERE user_id = v_lock_second FOR UPDATE;

  SELECT COALESCE(balance, 0) INTO v_requester_balance_before
  FROM public.profiles WHERE user_id = v_request.requester_id;

  -- Insufficient balance at approval time: reject the request (matches the
  -- prior client behavior's UX outcome) but touch ZERO balances -- this is a
  -- request-status-only mutation, not a financial one.
  IF v_requester_balance_before < v_request.amount THEN
    UPDATE public.money_return_requests
    SET
      status = 'rejected',
      rejected_at = now(),
      rejected_by = v_uid,
      rejection_reason = 'Insufficient balance at time of approval',
      updated_at = now()
    WHERE id = v_request.id;

    RETURN jsonb_build_object(
      'ok', true,
      'rejected', true,
      'reason', 'insufficient_balance',
      'request_id', v_request.id
    );
  END IF;

  SELECT COALESCE(balance, 0) INTO v_cashier_balance_before
  FROM public.profiles WHERE user_id = v_uid;

  UPDATE public.profiles
  SET balance = COALESCE(balance, 0) - v_request.amount, updated_at = now()
  WHERE user_id = v_request.requester_id
  RETURNING balance INTO v_requester_balance_after;

  IF v_requester_balance_after IS NULL THEN
    RAISE EXCEPTION 'Balance update affected no row; approval rolled back (requester)';
  END IF;

  UPDATE public.profiles
  SET balance = COALESCE(balance, 0) + v_request.amount, updated_at = now()
  WHERE user_id = v_uid
  RETURNING balance INTO v_cashier_balance_after;

  IF v_cashier_balance_after IS NULL THEN
    RAISE EXCEPTION 'Balance update affected no row; approval rolled back (cashier)';
  END IF;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, source_id, actor_user_id, note
  ) VALUES (
    v_org_id, v_request.requester_id, -v_request.amount,
    v_requester_balance_before, v_requester_balance_after,
    'cash_transfer_out', 'money_return', v_request.id, v_uid, v_request.note
  ) RETURNING id INTO v_requester_ledger_id;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, source_id, actor_user_id, note
  ) VALUES (
    v_org_id, v_uid, v_request.amount,
    v_cashier_balance_before, v_cashier_balance_after,
    'cash_transfer_in', 'money_return', v_request.id, v_uid, v_request.note
  ) RETURNING id INTO v_cashier_ledger_id;

  v_transfer_type := CASE WHEN v_requester_role = 'engineer' THEN 'engineer_to_cashier' ELSE 'employee_to_cashier' END;
  v_history_requester_role := public._legacy_transfer_history_role_v1(v_requester_role);

  INSERT INTO public.cash_transfer_history (
    organization_id, transferrer_id, transferrer_role, recipient_id, recipient_role,
    amount, transfer_type, transferred_at, payment_mode, notes
  ) VALUES (
    v_org_id, v_request.requester_id, v_history_requester_role, v_uid, 'cashier',
    v_request.amount, v_transfer_type, now(), 'cash',
    CASE WHEN v_request.note IS NULL OR trim(v_request.note) = ''
      THEN format('Money return request approved (%s)', v_request.id)
      ELSE format('Money return request approved (%s): %s', v_request.id, v_request.note)
    END
  );

  UPDATE public.money_return_requests
  SET
    status = 'approved',
    approved_at = now(),
    approved_by = v_uid,
    updated_at = now()
  WHERE id = v_request.id;

  -- FIFO-consume the requester's outstanding money_assignments from this
  -- cashier, exactly as the prior client-orchestrated version did.
  v_remaining := v_request.amount;
  FOR v_assignment IN
    SELECT id, amount FROM public.money_assignments
    WHERE recipient_id = v_request.requester_id
      AND cashier_id = v_uid
      AND is_returned = false
    ORDER BY assigned_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_assignment.amount, v_remaining);
    IF v_assignment.amount <= v_remaining THEN
      UPDATE public.money_assignments
      SET is_returned = true, returned_at = now(), return_transaction_id = v_request.id
      WHERE id = v_assignment.id;
    END IF;
    v_remaining := v_remaining - v_take;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'rejected', false,
    'request_id', v_request.id,
    'amount', v_request.amount,
    'requester_balance_after', v_requester_balance_after,
    'cashier_balance_after', v_cashier_balance_after,
    'ledger_entry_id', v_cashier_ledger_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_money_return_request_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_money_return_request_v2(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_money_return_request_v2(uuid) TO authenticated;

COMMENT ON FUNCTION public.approve_money_return_request_v2(uuid) IS
  'DOC-099. Atomic replacement for MoneyReturnService.approveReturnRequest''s '
  'browser-orchestrated balance PATCHes. Locks the request and both profile '
  'rows, resolves the amount from the request (never the browser), verifies '
  'sufficient balance after locking, debits requester/credits cashier, writes '
  'balance_ledger evidence (source_type=money_return), cash_transfer_history, '
  'FIFO-consumes money_assignments, and transitions the request status -- all '
  'in one transaction. Insufficient balance at approval time rejects the '
  'request with zero balance mutation, matching the prior UX.';

NOTIFY pgrst, 'reload schema';
