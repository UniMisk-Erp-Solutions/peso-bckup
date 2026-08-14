-- Optional per-cashier accountant mode: read-only access to reportable expenses + reports exports.
-- Org feature key: cashier_accountant_mode (organization_features).

ALTER TABLE public.organization_memberships
  ADD COLUMN IF NOT EXISTS is_accountant_cashier BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organization_memberships.is_accountant_cashier IS
  'When org feature cashier_accountant_mode is on and role is cashier: read-only accountant (no operational writes).';

CREATE OR REPLACE FUNCTION public.is_accountant_cashier(p_user_id UUID, p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = p_user_id
      AND om.organization_id = p_org_id
      AND om.is_active = true
      AND om.role = 'cashier'
      AND om.is_accountant_cashier = true
      AND public.get_organization_feature_enabled(p_org_id, 'cashier_accountant_mode') = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_accountant_cashier(UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Additive SELECT policies (do not modify admin/engineer policies)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Accountant cashiers can view reportable org expenses" ON public.expenses;
CREATE POLICY "Accountant cashiers can view reportable org expenses"
  ON public.expenses FOR SELECT
  USING (
    public.is_accountant_cashier(auth.uid(), organization_id)
    AND status IN ('verified', 'approved')
  );

DROP POLICY IF EXISTS "Accountant cashiers can view line items" ON public.expense_line_items;
CREATE POLICY "Accountant cashiers can view line items"
  ON public.expense_line_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_line_items.expense_id
        AND public.is_accountant_cashier(auth.uid(), e.organization_id)
        AND e.status IN ('verified', 'approved')
    )
  );

DROP POLICY IF EXISTS "Accountant cashiers can view attachments" ON public.attachments;
CREATE POLICY "Accountant cashiers can view attachments"
  ON public.attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = attachments.expense_id
        AND public.is_accountant_cashier(auth.uid(), e.organization_id)
        AND e.status IN ('verified', 'approved')
    )
  );

DROP POLICY IF EXISTS "Accountant cashiers can view form field values" ON public.expense_form_field_values;
CREATE POLICY "Accountant cashiers can view form field values"
  ON public.expense_form_field_values FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_form_field_values.expense_id
        AND public.is_accountant_cashier(auth.uid(), e.organization_id)
        AND e.status IN ('verified', 'approved')
    )
  );

DROP POLICY IF EXISTS "Accountant cashiers can view audit logs" ON public.audit_logs;
CREATE POLICY "Accountant cashiers can view audit logs"
  ON public.audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = audit_logs.expense_id
        AND public.is_accountant_cashier(auth.uid(), e.organization_id)
        AND e.status IN ('verified', 'approved')
    )
  );

-- ---------------------------------------------------------------------------
-- Tighten cashier WRITE policies (operational cashiers unchanged when flag false)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Cashiers can update managed profiles" ON public.profiles;
CREATE POLICY "Cashiers can update managed profiles"
  ON public.profiles FOR UPDATE
  USING (
    NOT public.is_accountant_cashier(auth.uid(), profiles.organization_id)
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.role = 'cashier'
        AND om.is_active = true
    )
    AND (
      profiles.user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.organization_memberships target_om
        WHERE target_om.user_id = profiles.user_id
          AND target_om.organization_id = profiles.organization_id
          AND target_om.is_active = true
          AND (
            (target_om.role = 'employee' AND public.cashier_can_manage_employee(auth.uid(), profiles.user_id))
            OR (target_om.role = 'engineer' AND public.cashier_can_manage_engineer(auth.uid(), profiles.user_id))
          )
      )
    )
  )
  WITH CHECK (
    NOT public.is_accountant_cashier(auth.uid(), profiles.organization_id)
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.role = 'cashier'
        AND om.is_active = true
    )
    AND (
      profiles.user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.organization_memberships target_om
        WHERE target_om.user_id = profiles.user_id
          AND target_om.organization_id = profiles.organization_id
          AND target_om.is_active = true
          AND (
            (target_om.role = 'employee' AND public.cashier_can_manage_employee(auth.uid(), profiles.user_id))
            OR (target_om.role = 'engineer' AND public.cashier_can_manage_engineer(auth.uid(), profiles.user_id))
          )
      )
    )
  );

DROP POLICY IF EXISTS "Cashiers can update return requests" ON public.money_return_requests;
CREATE POLICY "Cashiers can update return requests"
  ON public.money_return_requests FOR UPDATE
  USING (
    auth.uid() = cashier_id
    AND NOT public.is_accountant_cashier(
      auth.uid(),
      (SELECT req_om.organization_id FROM public.organization_memberships req_om
       WHERE req_om.user_id = money_return_requests.requester_id AND req_om.is_active = true
       LIMIT 1)
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships actor_om
      JOIN public.organization_memberships req_om
        ON req_om.organization_id = actor_om.organization_id
       AND req_om.user_id = money_return_requests.requester_id
       AND req_om.is_active = true
      WHERE actor_om.user_id = auth.uid()
        AND actor_om.is_active = true
        AND actor_om.role IN ('cashier', 'admin')
    )
  )
  WITH CHECK (
    auth.uid() = cashier_id
    AND NOT public.is_accountant_cashier(
      auth.uid(),
      (SELECT req_om.organization_id FROM public.organization_memberships req_om
       WHERE req_om.user_id = money_return_requests.requester_id AND req_om.is_active = true
       LIMIT 1)
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships actor_om
      JOIN public.organization_memberships req_om
        ON req_om.organization_id = actor_om.organization_id
       AND req_om.user_id = money_return_requests.requester_id
       AND req_om.is_active = true
      WHERE actor_om.user_id = auth.uid()
        AND actor_om.is_active = true
        AND actor_om.role IN ('cashier', 'admin')
    )
  );

DROP POLICY IF EXISTS "Cashiers and admins can create assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can create assignments"
  ON public.money_assignments FOR INSERT
  WITH CHECK (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND auth.uid() = cashier_id
    AND NOT public.is_accountant_cashier(
      auth.uid(),
      (SELECT p.organization_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1)
    )
  );

DROP POLICY IF EXISTS "Cashiers and admins can update assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can update assignments"
  ON public.money_assignments FOR UPDATE
  USING (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND NOT public.is_accountant_cashier(
      auth.uid(),
      (SELECT p.organization_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1)
    )
  )
  WITH CHECK (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND NOT public.is_accountant_cashier(
      auth.uid(),
      (SELECT p.organization_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1)
    )
  );

DROP POLICY IF EXISTS "Admins and cashiers can create transfers" ON public.cash_transfer_history;
CREATE POLICY "Admins and cashiers can create transfers"
  ON public.cash_transfer_history FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE user_id = auth.uid()
        AND organization_id = cash_transfer_history.organization_id
        AND role IN ('admin', 'cashier')
        AND is_active = true
    )
    AND auth.uid() = transferrer_id
    AND NOT public.is_accountant_cashier(auth.uid(), cash_transfer_history.organization_id)
  );

DROP POLICY IF EXISTS "Employees, engineers, admins, or cashiers when allowed can create expenses"
  ON public.expenses;
CREATE POLICY "Employees, engineers, admins, or cashiers when allowed can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
    AND NOT public.is_accountant_cashier(auth.uid(), organization_id)
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = organization_id
        AND om.is_active = true
        AND (
          om.role IN ('employee', 'engineer', 'admin', 'team_leader', 'executive')
          OR (
            om.role = 'cashier'
            AND EXISTS (
              SELECT 1 FROM public.organization_settings os
              WHERE os.organization_id = organization_id
                AND os.allow_cashier_expense_submission = true
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS "Users can update their submitted or rejected expenses" ON public.expenses;
CREATE POLICY "Users can update their submitted or rejected expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id
    AND status IN ('submitted', 'rejected')
    AND NOT public.is_accountant_cashier(auth.uid(), expenses.organization_id)
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
    AND status IN ('submitted', 'rejected')
    AND NOT public.is_accountant_cashier(auth.uid(), expenses.organization_id)
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  );

-- RPC guards
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

CREATE OR REPLACE FUNCTION public.cashier_return_money_to_admin(
  cashier_user_id UUID,
  admin_user_id UUID,
  amount_param DECIMAL(10,2)
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_balance DECIMAL(10,2);
  admin_balance DECIMAL(10,2);
  new_cashier_balance DECIMAL(10,2);
  new_admin_balance DECIMAL(10,2);
  cashier_org_id UUID;
  admin_org_id UUID;
BEGIN
  SELECT organization_id INTO cashier_org_id
  FROM profiles
  WHERE user_id = cashier_user_id;

  IF cashier_org_id IS NULL THEN
    RAISE EXCEPTION 'Cashier is not associated with an organization';
  END IF;

  IF public.is_accountant_cashier(cashier_user_id, cashier_org_id) THEN
    RAISE EXCEPTION 'Accountant cashiers have read-only access';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE user_id = cashier_user_id
      AND organization_id = cashier_org_id
      AND role = 'cashier'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'User is not a cashier in this organization';
  END IF;

  SELECT organization_id INTO admin_org_id
  FROM profiles
  WHERE user_id = admin_user_id;

  IF admin_org_id IS NULL THEN
    RAISE EXCEPTION 'Admin is not associated with an organization';
  END IF;

  IF admin_org_id != cashier_org_id THEN
    RAISE EXCEPTION 'Cashier and admin must be in the same organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE user_id = admin_user_id
      AND organization_id = admin_org_id
      AND role = 'admin'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Target user is not an admin in this organization';
  END IF;

  SELECT COALESCE(balance, 0) INTO cashier_balance
  FROM profiles
  WHERE user_id = cashier_user_id;

  SELECT COALESCE(balance, 0) INTO admin_balance
  FROM profiles
  WHERE user_id = admin_user_id;

  IF cashier_balance < amount_param THEN
    RAISE EXCEPTION 'Cashier has insufficient balance';
  END IF;

  new_cashier_balance := cashier_balance - amount_param;
  new_admin_balance := admin_balance + amount_param;

  UPDATE profiles
  SET balance = new_cashier_balance
  WHERE user_id = cashier_user_id;

  UPDATE profiles
  SET balance = new_admin_balance
  WHERE user_id = admin_user_id;

  INSERT INTO cash_transfer_history (
    organization_id,
    transferrer_id,
    transferrer_role,
    recipient_id,
    recipient_role,
    amount,
    transfer_type,
    transferred_at,
    notes
  ) VALUES (
    cashier_org_id,
    cashier_user_id,
    'cashier',
    admin_user_id,
    'admin',
    amount_param,
    'cashier_to_admin',
    NOW(),
    'Cashier returned money to admin'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.propose_balance_transfer_offer(UUID, UUID, DECIMAL, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cashier_return_money_to_admin(UUID, UUID, DECIMAL) TO authenticated;
