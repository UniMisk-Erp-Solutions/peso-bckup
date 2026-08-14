-- Fix cash-mode transfer offers: PL/pgSQL evaluates all INSERT expressions, so
-- v_bank.* in CASE branches raised "record v_bank is not assigned yet".
-- Run after 080608_1430_balance_transfer_offers.sql (do not edit that file).

CREATE OR REPLACE FUNCTION public.propose_balance_transfer_offer(
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
  v_recipient_engineer_id UUID;
  v_cashier_assigned_engineer_id UUID;
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

  SELECT p.reporting_engineer_id INTO v_recipient_engineer_id
  FROM public.profiles p
  WHERE p.user_id = p_recipient_id;

  IF v_transferrer_role = 'cashier' THEN
    SELECT p.cashier_assigned_engineer_id INTO v_cashier_assigned_engineer_id
    FROM public.profiles p
    WHERE p.user_id = v_caller;

    IF v_cashier_assigned_engineer_id IS NOT NULL THEN
      IF v_recipient_role IN ('employee', 'team_leader', 'executive')
        AND v_recipient_engineer_id IS DISTINCT FROM v_cashier_assigned_engineer_id THEN
        RAISE EXCEPTION 'You can only send offers to users under your assigned engineer';
      END IF;
      IF v_recipient_role = 'engineer'
        AND p_recipient_id IS DISTINCT FROM v_cashier_assigned_engineer_id THEN
        RAISE EXCEPTION 'You can only send offers to your assigned engineer';
      END IF;
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
    organization_id,
    transferrer_id,
    transferrer_role,
    recipient_id,
    recipient_role,
    amount,
    status,
    payment_mode,
    source_bank_account_id,
    source_bank_name_snapshot,
    source_account_holder_snapshot,
    source_account_number_masked_snapshot,
    transfer_type,
    note
  ) VALUES (
    p_organization_id,
    v_caller,
    v_transferrer_role,
    p_recipient_id,
    v_recipient_role,
    p_amount,
    'pending',
    p_payment_mode,
    v_source_bank_id,
    v_bank_name_snapshot,
    v_bank_holder_snapshot,
    v_bank_number_masked_snapshot,
    v_transfer_type,
    NULLIF(trim(p_note), '')
  )
  RETURNING id INTO v_offer_id;

  RETURN v_offer_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.propose_balance_transfer_offer(UUID, UUID, DECIMAL, TEXT, UUID, TEXT) TO authenticated;
