-- Add cashier to admin money return functionality
-- This allows cashiers to return money directly to admins

-- ============================================================================
-- PART 1: Add cashier_to_admin transfer type
-- ============================================================================

-- Update the transfer_type constraint to include cashier_to_admin
ALTER TABLE public.cash_transfer_history
DROP CONSTRAINT IF EXISTS cash_transfer_history_transfer_type_check;

ALTER TABLE public.cash_transfer_history
ADD CONSTRAINT cash_transfer_history_transfer_type_check 
CHECK (transfer_type IN (
  'admin_to_cashier', 
  'admin_to_employee', 
  'admin_to_engineer', 
  'cashier_to_employee', 
  'cashier_to_engineer',
  'cashier_to_admin',
  'employee_to_cashier',
  'engineer_to_cashier'
));

-- ============================================================================
-- PART 2: Function for cashier to return money to admin
-- ============================================================================

CREATE OR REPLACE FUNCTION cashier_return_money_to_admin(
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
  -- Verify cashier has permission
  SELECT organization_id INTO cashier_org_id
  FROM profiles
  WHERE user_id = cashier_user_id;
  
  IF cashier_org_id IS NULL THEN
    RAISE EXCEPTION 'Cashier is not associated with an organization';
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
  
  -- Verify admin has permission
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
  
  -- Get current balances
  SELECT COALESCE(balance, 0) INTO cashier_balance
  FROM profiles
  WHERE user_id = cashier_user_id;
  
  SELECT COALESCE(balance, 0) INTO admin_balance
  FROM profiles
  WHERE user_id = admin_user_id;
  
  -- Verify cashier has sufficient balance
  IF cashier_balance < amount_param THEN
    RAISE EXCEPTION 'Cashier has insufficient balance';
  END IF;
  
  -- Calculate new balances
  new_cashier_balance := cashier_balance - amount_param;
  new_admin_balance := admin_balance + amount_param;
  
  -- Update cashier balance (this bypasses RLS because function is SECURITY DEFINER)
  UPDATE profiles
  SET balance = new_cashier_balance
  WHERE user_id = cashier_user_id;
  
  -- Update admin balance
  UPDATE profiles
  SET balance = new_admin_balance
  WHERE user_id = admin_user_id;
  
  -- Log to cash_transfer_history
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

-- Grant execute permission
GRANT EXECUTE ON FUNCTION cashier_return_money_to_admin TO authenticated;

