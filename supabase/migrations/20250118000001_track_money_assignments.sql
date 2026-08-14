-- Create table to track money assignments from cashiers to employees
-- This tracks the path: cashier -> employee -> cashier (when returned)

CREATE TABLE IF NOT EXISTS public.money_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cashier_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  returned_at TIMESTAMP WITH TIME ZONE,
  is_returned BOOLEAN DEFAULT FALSE,
  return_transaction_id UUID, -- Reference to the return transaction if returned
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_money_assignments_recipient ON public.money_assignments(recipient_id, is_returned);
CREATE INDEX IF NOT EXISTS idx_money_assignments_cashier ON public.money_assignments(cashier_id);
CREATE INDEX IF NOT EXISTS idx_money_assignments_active ON public.money_assignments(recipient_id, is_returned) WHERE is_returned = false;

-- Enable RLS
ALTER TABLE public.money_assignments ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own assignments (as recipient)
CREATE POLICY "Users can view their own assignments"
  ON public.money_assignments FOR SELECT
  USING (auth.uid() = recipient_id OR auth.uid() = cashier_id);

-- Policy: Cashiers and admins can insert assignments
CREATE POLICY "Cashiers and admins can create assignments"
  ON public.money_assignments FOR INSERT
  WITH CHECK (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND auth.uid() = cashier_id
  );

-- Policy: Cashiers and admins can update assignments (for marking as returned)
CREATE POLICY "Cashiers and admins can update assignments"
  ON public.money_assignments FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'cashier') OR 
    public.has_role(auth.uid(), 'admin')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cashier') OR 
    public.has_role(auth.uid(), 'admin')
  );

-- Function to get the original cashier for a recipient
CREATE OR REPLACE FUNCTION get_original_cashier(recipient_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  original_cashier_id UUID;
BEGIN
  -- Find the most recent unreturned assignment for this recipient
  -- If multiple exist, we'll use FIFO (First In First Out) - oldest first
  SELECT cashier_id INTO original_cashier_id
  FROM public.money_assignments
  WHERE recipient_id = recipient_user_id
    AND is_returned = false
  ORDER BY assigned_at ASC
  LIMIT 1;
  
  RETURN original_cashier_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_original_cashier TO authenticated;

-- Add comment
COMMENT ON TABLE public.money_assignments IS 'Tracks money flow from cashiers to employees and back, maintaining assignment history';
COMMENT ON FUNCTION get_original_cashier IS 'Returns the cashier_id who originally assigned money to a recipient, using FIFO for multiple assignments';

