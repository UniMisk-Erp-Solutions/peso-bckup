-- Add organization_id column to existing cash_transfer_history table
-- This migration updates the table to support multi-tenancy

-- Add organization_id column if it doesn't exist
ALTER TABLE public.cash_transfer_history
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Make organization_id NOT NULL after we populate it
-- First, we need to populate existing rows with organization_id
-- Get organization_id from the transferrer's profile
UPDATE public.cash_transfer_history cth
SET organization_id = (
  SELECT p.organization_id 
  FROM public.profiles p 
  WHERE p.user_id = cth.transferrer_id 
  LIMIT 1
)
WHERE organization_id IS NULL;

-- Now make it NOT NULL
ALTER TABLE public.cash_transfer_history
ALTER COLUMN organization_id SET NOT NULL;

-- Add index for organization_id
CREATE INDEX IF NOT EXISTS idx_cash_transfer_history_org ON public.cash_transfer_history(organization_id, transferred_at DESC);

-- Drop old policies
DROP POLICY IF EXISTS "Admins can view all transfers" ON public.cash_transfer_history;
DROP POLICY IF EXISTS "Cashiers can view their transfers" ON public.cash_transfer_history;
DROP POLICY IF EXISTS "Admins and cashiers can create transfers" ON public.cash_transfer_history;
DROP POLICY IF EXISTS "Users can view transfers in their organization" ON public.cash_transfer_history;

-- Create new policies that use organization_memberships
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

