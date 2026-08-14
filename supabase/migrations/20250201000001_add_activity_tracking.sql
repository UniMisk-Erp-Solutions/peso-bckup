-- ============================================================================
-- ACTIVITY TRACKING FOR ORGANIZATIONS
-- ============================================================================
-- This migration adds triggers to track last activity (non-login) for organizations
-- Activity includes: expense creation, expense updates, money transfers, etc.
-- ============================================================================

-- Function to update organization activity when expenses are created/updated
CREATE OR REPLACE FUNCTION update_org_activity_on_expense()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update last_activity_at for the organization
  IF NEW.organization_id IS NOT NULL THEN
    UPDATE organizations
    SET last_activity_at = NOW()
    WHERE id = NEW.organization_id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger on expense insert
DROP TRIGGER IF EXISTS trigger_update_org_activity_on_expense_insert ON public.expenses;
CREATE TRIGGER trigger_update_org_activity_on_expense_insert
  AFTER INSERT ON public.expenses
  FOR EACH ROW
  WHEN (NEW.status != 'draft')
  EXECUTE FUNCTION update_org_activity_on_expense();

-- Trigger on expense update (only for status changes, not drafts)
DROP TRIGGER IF EXISTS trigger_update_org_activity_on_expense_update ON public.expenses;
CREATE TRIGGER trigger_update_org_activity_on_expense_update
  AFTER UPDATE ON public.expenses
  FOR EACH ROW
  WHEN (
    NEW.status != 'draft' 
    AND (OLD.status != NEW.status OR OLD.total_amount != NEW.total_amount)
  )
  EXECUTE FUNCTION update_org_activity_on_expense();

-- Function to update organization activity on money transfers
CREATE OR REPLACE FUNCTION update_org_activity_on_money_transfer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update last_activity_at for the organization
  IF NEW.organization_id IS NOT NULL THEN
    UPDATE organizations
    SET last_activity_at = NOW()
    WHERE id = NEW.organization_id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger on cash transfer history insert
DROP TRIGGER IF EXISTS trigger_update_org_activity_on_transfer ON public.cash_transfer_history;
CREATE TRIGGER trigger_update_org_activity_on_transfer
  AFTER INSERT ON public.cash_transfer_history
  FOR EACH ROW
  EXECUTE FUNCTION update_org_activity_on_money_transfer();

-- Function to update organization activity on money return requests
CREATE OR REPLACE FUNCTION update_org_activity_on_money_return()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update last_activity_at when return request is created or approved
  IF NEW.organization_id IS NOT NULL AND (NEW.status = 'pending' OR NEW.status = 'approved') THEN
    UPDATE organizations
    SET last_activity_at = NOW()
    WHERE id = NEW.organization_id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger on money return requests insert
DROP TRIGGER IF EXISTS trigger_update_org_activity_on_return_insert ON public.money_return_requests;
CREATE TRIGGER trigger_update_org_activity_on_return_insert
  AFTER INSERT ON public.money_return_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_org_activity_on_money_return();

-- Trigger on money return requests update (when approved)
DROP TRIGGER IF EXISTS trigger_update_org_activity_on_return_update ON public.money_return_requests;
CREATE TRIGGER trigger_update_org_activity_on_return_update
  AFTER UPDATE ON public.money_return_requests
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved'))
  EXECUTE FUNCTION update_org_activity_on_money_return();

-- Grant execute permission
GRANT EXECUTE ON FUNCTION update_org_activity_on_expense TO authenticated;
GRANT EXECUTE ON FUNCTION update_org_activity_on_money_transfer TO authenticated;
GRANT EXECUTE ON FUNCTION update_org_activity_on_money_return TO authenticated;

