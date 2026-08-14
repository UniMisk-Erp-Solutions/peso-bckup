-- Add field to track which engineer a cashier is assigned to
-- This creates zones/departments: Cashier -> Engineer -> Employees
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS cashier_assigned_engineer_id UUID REFERENCES auth.users(id);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_profiles_cashier_assigned_engineer 
  ON public.profiles(cashier_assigned_engineer_id);

-- Add comment
COMMENT ON COLUMN public.profiles.cashier_assigned_engineer_id IS 'Tracks which engineer a cashier is assigned to, creating zones/departments. Cashiers can only manage employees under their assigned engineer.';

-- Function to check if a cashier can manage a specific employee
-- A cashier can manage an employee if:
-- 1. The employee's reporting_engineer_id matches the cashier's assigned_engineer_id
-- 2. OR the cashier is assigned to the engineer who manages that employee
CREATE OR REPLACE FUNCTION cashier_can_manage_employee(
  cashier_user_id UUID,
  employee_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cashier_engineer_id UUID;
  employee_engineer_id UUID;
BEGIN
  -- Get the engineer assigned to the cashier
  SELECT cashier_assigned_engineer_id INTO cashier_engineer_id
  FROM public.profiles
  WHERE user_id = cashier_user_id;
  
  -- Get the engineer assigned to the employee
  SELECT reporting_engineer_id INTO employee_engineer_id
  FROM public.profiles
  WHERE user_id = employee_user_id;
  
  -- Cashier can manage if:
  -- 1. Cashier has an assigned engineer AND employee is under that same engineer
  -- 2. OR cashier has no assigned engineer (can manage all - for backward compatibility)
  IF cashier_engineer_id IS NULL THEN
    RETURN TRUE; -- No assignment means can manage all (backward compatibility)
  END IF;
  
  RETURN cashier_engineer_id = employee_engineer_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION cashier_can_manage_employee TO authenticated;

-- Add comment
COMMENT ON FUNCTION cashier_can_manage_employee IS 'Checks if a cashier can manage a specific employee based on engineer assignments';

