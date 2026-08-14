-- Optional transfer recipient acceptance: pending offers before balance changes

CREATE TABLE IF NOT EXISTS public.balance_transfer_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  transferrer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transferrer_role TEXT NOT NULL CHECK (transferrer_role IN ('admin', 'cashier')),
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_role TEXT NOT NULL CHECK (
    recipient_role IN ('admin', 'cashier', 'engineer', 'employee', 'team_leader', 'executive')
  ),
  amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  payment_mode TEXT NOT NULL DEFAULT 'cash' CHECK (payment_mode IN ('cash', 'bank_transfer')),
  source_bank_account_id UUID REFERENCES public.organization_bank_accounts(id) ON DELETE SET NULL,
  source_bank_name_snapshot TEXT,
  source_account_holder_snapshot TEXT,
  source_account_number_masked_snapshot TEXT,
  transfer_type TEXT NOT NULL,
  note TEXT,
  rejection_reason TEXT,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  responded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_transfer_offers_recipient_pending
  ON public.balance_transfer_offers (recipient_id, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_balance_transfer_offers_transferrer
  ON public.balance_transfer_offers (transferrer_id, status);

CREATE INDEX IF NOT EXISTS idx_balance_transfer_offers_org_proposed
  ON public.balance_transfer_offers (organization_id, proposed_at DESC);

COMMENT ON TABLE public.balance_transfer_offers IS
  'Pending balance allocation offers from admin/cashier to recipients; balances change only on accept.';

ALTER TABLE public.balance_transfer_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS balance_transfer_offers_select ON public.balance_transfer_offers;
CREATE POLICY balance_transfer_offers_select ON public.balance_transfer_offers
  FOR SELECT TO authenticated
  USING (
    transferrer_id = auth.uid()
    OR recipient_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = balance_transfer_offers.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- Mutations only via SECURITY DEFINER RPCs
DROP POLICY IF EXISTS balance_transfer_offers_insert ON public.balance_transfer_offers;
DROP POLICY IF EXISTS balance_transfer_offers_update ON public.balance_transfer_offers;

CREATE OR REPLACE FUNCTION public._mask_bank_account_number(account_number TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN account_number IS NULL OR length(trim(account_number)) = 0 THEN NULL
    WHEN length(trim(account_number)) <= 4 THEN '****'
    ELSE repeat('*', greatest(length(trim(account_number)) - 4, 0)) || right(trim(account_number), 4)
  END;
$$;

CREATE OR REPLACE FUNCTION public._primary_org_role(p_user_id UUID, p_org_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT om.role
  FROM public.organization_memberships om
  WHERE om.user_id = p_user_id
    AND om.organization_id = p_org_id
    AND om.is_active = true
  ORDER BY CASE om.role
    WHEN 'admin' THEN 1
    WHEN 'cashier' THEN 2
    WHEN 'engineer' THEN 3
    WHEN 'executive' THEN 4
    WHEN 'team_leader' THEN 5
    WHEN 'employee' THEN 6
    ELSE 99
  END
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public._resolve_outbound_transfer_type(
  p_transferrer_role TEXT,
  p_recipient_role TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_transferrer_role = 'admin' THEN
    IF p_recipient_role = 'cashier' THEN RETURN 'admin_to_cashier'; END IF;
    IF p_recipient_role IN ('employee', 'team_leader', 'executive') THEN RETURN 'admin_to_employee'; END IF;
    IF p_recipient_role = 'engineer' THEN RETURN 'admin_to_engineer'; END IF;
    IF p_recipient_role = 'admin' THEN RETURN 'admin_to_admin'; END IF;
  ELSIF p_transferrer_role = 'cashier' THEN
    IF p_recipient_role IN ('employee', 'team_leader', 'executive') THEN RETURN 'cashier_to_employee'; END IF;
    IF p_recipient_role = 'engineer' THEN RETURN 'cashier_to_engineer'; END IF;
    IF p_recipient_role = 'cashier' THEN RETURN 'cashier_to_employee'; END IF;
    IF p_recipient_role = 'admin' THEN RETURN 'cashier_to_admin'; END IF;
  END IF;
  RAISE EXCEPTION 'Unsupported transfer pair: % to %', p_transferrer_role, p_recipient_role;
END;
$$;

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
  v_offer_id UUID;
  v_history_recipient_role TEXT;
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

  IF p_payment_mode = 'bank_transfer' THEN
    IF p_source_bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Source bank account is required for bank transfer offers';
    END IF;
    SELECT ba.bank_name, ba.account_holder_name, ba.account_number, ba.is_active
    INTO v_bank
    FROM public.organization_bank_accounts ba
    WHERE ba.id = p_source_bank_account_id
      AND ba.organization_id = p_organization_id;
    IF NOT FOUND OR v_bank.is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Invalid or inactive source bank account';
    END IF;
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
    CASE WHEN p_payment_mode = 'bank_transfer' THEN p_source_bank_account_id ELSE NULL END,
    CASE WHEN p_payment_mode = 'bank_transfer' THEN v_bank.bank_name ELSE NULL END,
    CASE WHEN p_payment_mode = 'bank_transfer' THEN v_bank.account_holder_name ELSE NULL END,
    CASE WHEN p_payment_mode = 'bank_transfer' THEN public._mask_bank_account_number(v_bank.account_number) ELSE NULL END,
    v_transfer_type,
    NULLIF(trim(p_note), '')
  )
  RETURNING id INTO v_offer_id;

  RETURN v_offer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_balance_transfer_offer(p_offer_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  offer public.balance_transfer_offers%ROWTYPE;
  v_recipient_balance DECIMAL(10, 2);
  v_transferrer_balance DECIMAL(10, 2);
  v_new_recipient_balance DECIMAL(10, 2);
  v_new_transferrer_balance DECIMAL(10, 2);
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

  SELECT COALESCE(balance, 0) INTO v_recipient_balance
  FROM public.profiles WHERE user_id = offer.recipient_id;

  v_new_recipient_balance := v_recipient_balance + offer.amount;

  IF offer.transferrer_role = 'cashier' AND offer.payment_mode = 'cash' THEN
    SELECT COALESCE(balance, 0) INTO v_transferrer_balance
    FROM public.profiles WHERE user_id = offer.transferrer_id;

    IF v_transferrer_balance < offer.amount THEN
      RAISE EXCEPTION 'Sender has insufficient balance to complete this transfer';
    END IF;

    v_new_transferrer_balance := v_transferrer_balance - offer.amount;
    UPDATE public.profiles SET balance = v_new_transferrer_balance WHERE user_id = offer.transferrer_id;
  END IF;

  UPDATE public.profiles SET balance = v_new_recipient_balance WHERE user_id = offer.recipient_id;

  IF offer.transferrer_role = 'cashier'
    AND offer.recipient_role IN ('employee', 'engineer', 'team_leader', 'executive') THEN
    INSERT INTO public.money_assignments (cashier_id, recipient_id, amount)
    VALUES (offer.transferrer_id, offer.recipient_id, offer.amount);
  END IF;

  v_history_recipient_role := CASE
    WHEN offer.recipient_role IN ('team_leader', 'executive') THEN 'employee'
    ELSE offer.recipient_role
  END;

  INSERT INTO public.cash_transfer_history (
    organization_id,
    transferrer_id,
    transferrer_role,
    recipient_id,
    recipient_role,
    amount,
    transfer_type,
    payment_mode,
    source_bank_account_id,
    source_bank_name_snapshot,
    source_account_holder_snapshot,
    source_account_number_masked_snapshot,
    notes,
    transferred_at
  ) VALUES (
    offer.organization_id,
    offer.transferrer_id,
    offer.transferrer_role,
    offer.recipient_id,
    v_history_recipient_role,
    offer.amount,
    offer.transfer_type,
    offer.payment_mode,
    offer.source_bank_account_id,
    offer.source_bank_name_snapshot,
    offer.source_account_holder_snapshot,
    offer.source_account_number_masked_snapshot,
    offer.note,
    NOW()
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

CREATE OR REPLACE FUNCTION public.reject_balance_transfer_offer(
  p_offer_id UUID,
  p_reason TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  offer public.balance_transfer_offers%ROWTYPE;
  v_reason TEXT := trim(coalesce(p_reason, ''));
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Rejection reason must be at least 3 characters';
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
    RAISE EXCEPTION 'Only the recipient can reject this offer';
  END IF;

  UPDATE public.balance_transfer_offers
  SET
    status = 'rejected',
    rejection_reason = v_reason,
    responded_at = NOW(),
    responded_by = v_caller,
    updated_at = NOW()
  WHERE id = offer.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_balance_transfer_offer(p_offer_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  offer public.balance_transfer_offers%ROWTYPE;
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
    RAISE EXCEPTION 'Only pending offers can be cancelled';
  END IF;

  IF offer.transferrer_id <> v_caller THEN
    RAISE EXCEPTION 'Only the sender can cancel this offer';
  END IF;

  UPDATE public.balance_transfer_offers
  SET
    status = 'cancelled',
    responded_at = NOW(),
    responded_by = v_caller,
    updated_at = NOW()
  WHERE id = offer.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.propose_balance_transfer_offer TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_balance_transfer_offer TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_balance_transfer_offer TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_balance_transfer_offer TO authenticated;
