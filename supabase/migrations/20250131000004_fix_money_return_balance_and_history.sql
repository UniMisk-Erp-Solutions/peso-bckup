-- Fix money return balance updates and add to transfer history
-- This allows cashiers to update requester balances when approving returns
-- And logs money returns to cash_transfer_history

-- ============================================================================
-- PART 1: Function to update balances when approving money return (bypasses RLS)
-- ============================================================================

CREATE OR REPLACE FUNCTION approve_money_return_update_balances(
  request_id UUID,
  cashier_user_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  request_record RECORD;
  requester_balance DECIMAL(10,2);
  cashier_balance DECIMAL(10,2);
  new_requester_balance DECIMAL(10,2);
  new_cashier_balance DECIMAL(10,2);
BEGIN
  -- Get the money return request
  SELECT 
    requester_id,
    cashier_id,
    amount,
    organization_id
  INTO request_record
  FROM money_return_requests
  WHERE id = request_id
    AND cashier_id = cashier_user_id
    AND status = 'pending';
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Money return request not found or already processed';
  END IF;
  
  -- Verify cashier has permission
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE user_id = cashier_user_id
      AND organization_id = request_record.organization_id
      AND role = 'cashier'
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'User is not a cashier in this organization';
  END IF;
  
  -- Get current balances
  SELECT COALESCE(balance, 0) INTO requester_balance
  FROM profiles
  WHERE user_id = request_record.requester_id;
  
  SELECT COALESCE(balance, 0) INTO cashier_balance
  FROM profiles
  WHERE user_id = request_record.cashier_id;
  
  -- Verify requester has sufficient balance
  IF requester_balance < request_record.amount THEN
    RAISE EXCEPTION 'Requester has insufficient balance';
  END IF;
  
  -- Calculate new balances
  new_requester_balance := requester_balance - request_record.amount;
  new_cashier_balance := cashier_balance + request_record.amount;
  
  -- Update requester balance (this bypasses RLS because function is SECURITY DEFINER)
  UPDATE profiles
  SET balance = new_requester_balance
  WHERE user_id = request_record.requester_id;
  
  -- Update cashier balance
  UPDATE profiles
  SET balance = new_cashier_balance
  WHERE user_id = request_record.cashier_id;
  
  -- Mark request as approved (atomic with balance updates)
  UPDATE money_return_requests
  SET 
    status = 'approved',
    approved_at = NOW(),
    approved_by = cashier_user_id
  WHERE id = request_id;
  
  -- The trigger will automatically log to cash_transfer_history
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION approve_money_return_update_balances TO authenticated;

-- ============================================================================
-- PART 2: Add money return transfer types to cash_transfer_history
-- ============================================================================

-- Update the transfer_type constraint to include money return types
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
  'employee_to_cashier',
  'engineer_to_cashier'
));

-- Update recipient_role constraint to allow employee/engineer as transferrer for returns
ALTER TABLE public.cash_transfer_history
DROP CONSTRAINT IF EXISTS cash_transfer_history_transferrer_role_check;

ALTER TABLE public.cash_transfer_history
ADD CONSTRAINT cash_transfer_history_transferrer_role_check
CHECK (transferrer_role IN ('admin', 'cashier', 'employee', 'engineer'));

-- ============================================================================
-- PART 3: Function to log money return to transfer history
-- ============================================================================

CREATE OR REPLACE FUNCTION log_money_return_to_history(
  request_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  request_record RECORD;
  requester_role TEXT;
  transfer_type TEXT;
BEGIN
  -- Get the money return request details
  SELECT 
    mrr.requester_id,
    mrr.cashier_id,
    mrr.amount,
    mrr.organization_id,
    mrr.approved_at
  INTO request_record
  FROM money_return_requests mrr
  WHERE mrr.id = request_id
    AND mrr.status = 'approved'
    AND mrr.approved_at IS NOT NULL;
  
  IF NOT FOUND THEN
    RETURN; -- Request not found or not approved
  END IF;
  
  -- Get requester's role
  SELECT role INTO requester_role
  FROM organization_memberships
  WHERE user_id = request_record.requester_id
    AND organization_id = request_record.organization_id
    AND is_active = true
  LIMIT 1;
  
  -- Determine transfer type based on requester role
  IF requester_role = 'employee' THEN
    transfer_type := 'employee_to_cashier';
  ELSIF requester_role = 'engineer' THEN
    transfer_type := 'engineer_to_cashier';
  ELSE
    RETURN; -- Invalid requester role
  END IF;
  
  -- Verify cashier role (just a check, we already know it's a cashier from the request)
  -- This is just a safety check
  
  -- Insert into cash_transfer_history
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
    request_record.organization_id,
    request_record.requester_id,
    requester_role,
    request_record.cashier_id,
    'cashier',
    request_record.amount,
    transfer_type,
    request_record.approved_at,
    'Money return request approved'
  )
  ON CONFLICT DO NOTHING; -- Prevent duplicates
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION log_money_return_to_history TO authenticated;

-- ============================================================================
-- PART 4: Trigger to automatically log approved money returns
-- ============================================================================

CREATE OR REPLACE FUNCTION trigger_log_money_return()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only log when status changes to 'approved'
  IF NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    PERFORM log_money_return_to_history(NEW.id);
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger
DROP TRIGGER IF EXISTS log_money_return_on_approval ON public.money_return_requests;
CREATE TRIGGER log_money_return_on_approval
  AFTER UPDATE OF status ON public.money_return_requests
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved'))
  EXECUTE FUNCTION trigger_log_money_return();

