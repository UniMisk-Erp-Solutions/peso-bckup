-- Add field to track which cashier an employee or engineer is assigned to
-- This ensures employees and engineers return money to their assigned cashier
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS assigned_cashier_id UUID REFERENCES auth.users(id);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_profiles_assigned_cashier 
  ON public.profiles(assigned_cashier_id);

-- Add comment
COMMENT ON COLUMN public.profiles.assigned_cashier_id IS 'Tracks which cashier an employee or engineer is assigned to. Employees and engineers return money to their assigned cashier.';

-- Add constraint to ensure one cashier per employee (optional - can be enforced at application level)
-- Note: We'll enforce this in the application logic rather than database constraint
-- to allow flexibility during transitions

