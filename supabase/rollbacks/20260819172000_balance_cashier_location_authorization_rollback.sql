-- Rollback for 20260819172000_balance_cashier_location_authorization.sql
-- Restores balance_add_funds_v1 to its exact 20260819170000 body
-- (engineer-only cashier scoping, no location scoping).

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
  v_debit_actor          boolean;
  v_cashier_assigned_engineer_id uuid;
  v_target_reporting_engineer_id uuid;
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

  IF p_idempotency_key IS NOT NULL THEN
    SELECT bl.id, bl.organization_id INTO v_existing
    FROM public.balance_ledger bl
    WHERE bl.idempotency_key = p_idempotency_key
      AND bl.source_type = 'manual_add'
      AND bl.organization_id = v_org_id
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true, 'already_applied', true, 'ledger_entry_id', v_existing.id
      );
    END IF;
  END IF;

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

  IF v_caller_role = 'cashier' THEN
    IF v_target_role IN ('admin', 'cashier') THEN
      RAISE EXCEPTION 'Cashiers cannot add funds to % accounts', v_target_role;
    END IF;

    SELECT p.cashier_assigned_engineer_id INTO v_cashier_assigned_engineer_id
    FROM public.profiles p WHERE p.user_id = v_uid;

    IF v_cashier_assigned_engineer_id IS NOT NULL THEN
      IF v_target_role = 'employee' THEN
        SELECT p.reporting_engineer_id INTO v_target_reporting_engineer_id
        FROM public.profiles p WHERE p.user_id = p_target_user_id;
        IF v_target_reporting_engineer_id IS DISTINCT FROM v_cashier_assigned_engineer_id THEN
          RAISE EXCEPTION 'You can only manage employees under your assigned engineer''s zone/department';
        END IF;
      ELSIF v_target_role = 'engineer' THEN
        IF p_target_user_id IS DISTINCT FROM v_cashier_assigned_engineer_id THEN
          RAISE EXCEPTION 'You can only manage your assigned engineer';
        END IF;
      END IF;
    END IF;
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

  v_debit_actor := (p_payment_mode = 'cash' AND v_caller_role = 'cashier');

  IF v_debit_actor THEN
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

    UPDATE public.profiles
    SET balance = COALESCE(balance, 0) - p_amount, updated_at = now()
    WHERE user_id = v_uid AND organization_id = v_org_id
    RETURNING balance INTO v_actor_balance_after;

    IF v_actor_balance_after IS NULL THEN
      RAISE EXCEPTION 'Balance update affected no row; transfer rolled back (actor)';
    END IF;
  ELSE
    PERFORM 1 FROM public.profiles WHERE user_id = p_target_user_id FOR UPDATE;
  END IF;

  SELECT COALESCE(balance, 0) INTO v_target_balance_before
  FROM public.profiles WHERE user_id = p_target_user_id AND organization_id = v_org_id;

  UPDATE public.profiles
  SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_target_user_id AND organization_id = v_org_id
  RETURNING balance, name INTO v_target_balance_after, v_target_name;

  IF v_target_balance_after IS NULL THEN
    RAISE EXCEPTION 'Balance update affected no row; transfer rolled back (target)';
  END IF;

  IF v_debit_actor THEN
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

NOTIFY pgrst, 'reload schema';
