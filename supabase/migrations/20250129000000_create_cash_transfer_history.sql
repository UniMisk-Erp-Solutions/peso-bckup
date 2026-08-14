-- Create table to track all cash transfers (comprehensive history)
-- This tracks transfers from admin/cashier to managers/employees
-- Includes: admin->cashier, admin->employee, admin->engineer, cashier->employee, cashier->engineer

CREATE TABLE IF NOT EXISTS public.cash_transfer_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transferrer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transferrer_role TEXT NOT NULL CHECK (transferrer_role IN ('admin', 'cashier')),
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('admin', 'cashier', 'engineer', 'employee')),
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  transfer_type TEXT NOT NULL CHECK (transfer_type IN ('admin_to_cashier', 'admin_to_employee', 'admin_to_engineer', 'cashier_to_employee', 'cashier_to_engineer')),
  transferred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add organization_id column if it doesn't exist (for existing tables)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'cash_transfer_history' 
    AND column_name = 'organization_id'
  ) THEN
    ALTER TABLE public.cash_transfer_history
    ADD COLUMN organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;
    
    -- Populate existing rows with organization_id from transferrer's profile
    UPDATE public.cash_transfer_history cth
    SET organization_id = (
      SELECT p.organization_id 
      FROM public.profiles p 
      WHERE p.user_id = cth.transferrer_id 
      LIMIT 1
    )
    WHERE organization_id IS NULL;
    
    -- Make it NOT NULL after population
    ALTER TABLE public.cash_transfer_history
    ALTER COLUMN organization_id SET NOT NULL;
  END IF;
END $$;

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_cash_transfer_history_org ON public.cash_transfer_history(organization_id, transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_transfer_history_transferrer ON public.cash_transfer_history(transferrer_id, transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_transfer_history_recipient ON public.cash_transfer_history(recipient_id, transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_transfer_history_type ON public.cash_transfer_history(transfer_type, transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_transfer_history_date ON public.cash_transfer_history(transferred_at DESC);

-- Enable RLS
ALTER TABLE public.cash_transfer_history ENABLE ROW LEVEL SECURITY;

-- Drop old policies if they exist (handle all possible policy names)
DO $$ 
BEGIN
  -- Drop policies that might exist
  DROP POLICY IF EXISTS "Admins can view all transfers" ON public.cash_transfer_history;
  DROP POLICY IF EXISTS "Cashiers can view their transfers" ON public.cash_transfer_history;
  DROP POLICY IF EXISTS "Admins and cashiers can create transfers" ON public.cash_transfer_history;
  DROP POLICY IF EXISTS "Users can view transfers in their organization" ON public.cash_transfer_history;
EXCEPTION
  WHEN OTHERS THEN
    -- Ignore errors if policies don't exist
    NULL;
END $$;

-- Policy: Users can view transfers in their organization
CREATE POLICY "Users can view transfers in their organization"
  ON public.cash_transfer_history FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true
    )
    AND (
      -- Admins can see all transfers in their org
      EXISTS (
        SELECT 1 FROM public.organization_memberships
        WHERE user_id = auth.uid() 
          AND organization_id = cash_transfer_history.organization_id
          AND role = 'admin' 
          AND is_active = true
      )
      OR
      -- Cashiers can see transfers they made or received
      (
        EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() 
            AND organization_id = cash_transfer_history.organization_id
            AND role = 'cashier' 
            AND is_active = true
        )
        AND (auth.uid() = transferrer_id OR auth.uid() = recipient_id)
      )
    )
  );

-- Policy: Admins and cashiers can insert transfers in their organization
CREATE POLICY "Admins and cashiers can create transfers"
  ON public.cash_transfer_history FOR INSERT
  WITH CHECK (
    -- User must belong to the organization
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true
    )
    AND
    -- User must be admin or cashier
    EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE user_id = auth.uid() 
        AND organization_id = cash_transfer_history.organization_id
        AND role IN ('admin', 'cashier')
        AND is_active = true
    )
    AND
    -- User must be the transferrer
    auth.uid() = transferrer_id
  );

-- Add comment
COMMENT ON TABLE public.cash_transfer_history IS 'Comprehensive history of all cash transfers from admin/cashier to managers/employees';
COMMENT ON COLUMN public.cash_transfer_history.transfer_type IS 'Type of transfer: admin_to_cashier, admin_to_employee, admin_to_engineer, cashier_to_employee, cashier_to_engineer';

