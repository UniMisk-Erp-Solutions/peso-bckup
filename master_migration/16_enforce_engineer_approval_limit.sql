-- ============================================================================
-- MIGRATION: Enforce Engineer Approval Limit at Database Level
-- ============================================================================
-- This migration adds a database-level check to prevent engineers from
-- approving expenses above their approval limit, even if they bypass the app.
-- ============================================================================

-- ============================================================================
-- PART 1: CREATE FUNCTION TO CHECK ENGINEER APPROVAL LIMIT
-- ============================================================================

CREATE OR REPLACE FUNCTION check_engineer_approval_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  approver_role TEXT;
  approval_limit DECIMAL(10,2);
  expense_amount DECIMAL(10,2);
BEGIN
  -- Only check if status is being changed to 'approved'
  IF NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    
    -- Get the role of the user making the update
    SELECT role INTO approver_role
    FROM public.organization_memberships
    WHERE user_id = auth.uid()
      AND organization_id = NEW.organization_id
      AND is_active = true
    LIMIT 1;
    
    -- If user is an engineer, check the approval limit
    IF approver_role = 'engineer' THEN
      -- Get the engineer approval limit for this organization
      SELECT engineer_approval_limit INTO approval_limit
      FROM public.organization_settings
      WHERE organization_id = NEW.organization_id
      LIMIT 1;
      
      -- Default to 50000 if limit not set
      IF approval_limit IS NULL THEN
        approval_limit := 50000;
      END IF;
      
      -- Get the expense amount
      expense_amount := NEW.total_amount;
      
      -- Block approval if amount exceeds limit
      IF expense_amount > approval_limit THEN
        RAISE EXCEPTION 'Engineers cannot approve expenses above ₹%. This expense (₹%) exceeds the limit. Please verify instead of approving.', 
          approval_limit, expense_amount;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- ============================================================================
-- PART 2: CREATE TRIGGER TO ENFORCE LIMIT
-- ============================================================================

-- Drop trigger if it exists
DROP TRIGGER IF EXISTS enforce_engineer_approval_limit ON public.expenses;

-- Create trigger that runs before update
CREATE TRIGGER enforce_engineer_approval_limit
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION check_engineer_approval_limit();

-- ============================================================================
-- PART 3: GRANT PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION check_engineer_approval_limit() TO authenticated;

-- ============================================================================
-- PART 4: COMMENTS
-- ============================================================================

COMMENT ON FUNCTION check_engineer_approval_limit() IS 'Prevents engineers from approving expenses above their approval limit. Enforces limit at database level.';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Database-level enforcement is now active:
-- ✅ Engineers cannot approve expenses above their limit (even via SQL)
-- ✅ Limit is checked from organization_settings table
-- ✅ Default limit is ₹50,000 if not set
-- ✅ Only blocks when status changes to 'approved'
-- ✅ Admins are not affected by this check
-- ============================================================================

