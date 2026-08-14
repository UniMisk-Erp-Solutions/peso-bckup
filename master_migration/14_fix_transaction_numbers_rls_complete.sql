-- ============================================================================
-- MIGRATION: Fix Transaction Numbers Per-Organization (Complete Fix)
-- ============================================================================
-- This migration fixes the RLS issues and ensures transaction numbers work
-- correctly per organization. Run this if you've already run migration 13.
-- ============================================================================

-- ============================================================================
-- PART 1: ENSURE TABLE EXISTS AND HAS PROPER STRUCTURE
-- ============================================================================

-- Create table to track the next transaction number for each organization
CREATE TABLE IF NOT EXISTS public.organization_transaction_sequences (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  next_number INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_org_txn_sequences_org_id 
  ON public.organization_transaction_sequences(organization_id);

-- Enable RLS
ALTER TABLE public.organization_transaction_sequences ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- PART 2: DROP AND RECREATE ALL POLICIES
-- ============================================================================

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view sequences for their organization" ON public.organization_transaction_sequences;
DROP POLICY IF EXISTS "System can manage sequences for transaction numbers" ON public.organization_transaction_sequences;
DROP POLICY IF EXISTS "Allow authenticated users to manage sequences" ON public.organization_transaction_sequences;

-- Policy: Users can view sequences for their organization
CREATE POLICY "Users can view sequences for their organization"
  ON public.organization_transaction_sequences FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = organization_transaction_sequences.organization_id
        AND om.is_active = true
    )
  );

-- Policy: Allow INSERT/UPDATE for sequence management (needed by SECURITY DEFINER functions)
-- This policy allows the generate_transaction_number function to insert/update sequences
CREATE POLICY "Allow sequence management for transaction numbers"
  ON public.organization_transaction_sequences FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- PART 3: DROP AND RECREATE FUNCTIONS WITH SECURITY DEFINER
-- ============================================================================

-- Drop the trigger first (since it depends on the function)
DROP TRIGGER IF EXISTS trigger_assign_transaction_number ON public.expenses;

-- Drop old functions
DROP FUNCTION IF EXISTS assign_transaction_number();
DROP FUNCTION IF EXISTS generate_transaction_number(UUID);
DROP FUNCTION IF EXISTS generate_transaction_number();

-- Create new function that generates transaction numbers per organization
-- SECURITY DEFINER allows the function to bypass RLS when inserting/updating sequences
CREATE OR REPLACE FUNCTION generate_transaction_number(org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num INTEGER;
  formatted_num TEXT;
BEGIN
  -- Get or create the next number for this organization
  INSERT INTO public.organization_transaction_sequences (organization_id, next_number, updated_at)
  VALUES (org_id, 1, now())
  ON CONFLICT (organization_id) 
  DO UPDATE SET 
    next_number = organization_transaction_sequences.next_number + 1,
    updated_at = now()
  RETURNING next_number INTO next_num;
  
  -- Format as 5-digit number with leading zeros
  formatted_num := LPAD(next_num::TEXT, 5, '0');
  
  RETURN formatted_num;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION generate_transaction_number(UUID) TO authenticated;

-- Create new trigger function that uses organization_id
-- SECURITY DEFINER allows the function to call generate_transaction_number which needs to bypass RLS
CREATE OR REPLACE FUNCTION assign_transaction_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only assign transaction number when status changes to 'submitted' and transaction_number is NULL
  IF NEW.status = 'submitted' 
     AND (OLD.status IS NULL OR OLD.status != 'submitted') 
     AND NEW.transaction_number IS NULL 
     AND NEW.organization_id IS NOT NULL THEN
    NEW.transaction_number := generate_transaction_number(NEW.organization_id);
  END IF;
  
  RETURN NEW;
END;
$$;

-- Recreate the trigger
CREATE TRIGGER trigger_assign_transaction_number
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION assign_transaction_number();

-- ============================================================================
-- PART 4: INITIALIZE SEQUENCES FOR EXISTING ORGANIZATIONS
-- ============================================================================

DO $$
DECLARE
  org_record RECORD;
  expense_count INTEGER;
BEGIN
  -- For each organization, initialize the sequence based on existing expenses
  FOR org_record IN 
    SELECT DISTINCT organization_id 
    FROM public.expenses 
    WHERE organization_id IS NOT NULL
    ORDER BY organization_id
  LOOP
    -- Count submitted expenses for this organization
    SELECT COUNT(*) INTO expense_count
    FROM public.expenses
    WHERE organization_id = org_record.organization_id
      AND transaction_number IS NOT NULL
      AND status = 'submitted';
    
    -- Initialize the sequence for this organization
    -- Set next_number to the count + 1 (so next expense gets the right number)
    INSERT INTO public.organization_transaction_sequences (organization_id, next_number, updated_at)
    VALUES (org_record.organization_id, expense_count + 1, now())
    ON CONFLICT (organization_id) 
    DO UPDATE SET next_number = GREATEST(organization_transaction_sequences.next_number, expense_count + 1);
    
    RAISE NOTICE 'Initialized sequence for organization %: next number will be %', 
      org_record.organization_id, expense_count + 1;
  END LOOP;
END $$;

-- ============================================================================
-- PART 5: VERIFY CONSTRAINT EXISTS
-- ============================================================================

-- Ensure the unique constraint is per organization
ALTER TABLE public.expenses 
DROP CONSTRAINT IF EXISTS expenses_transaction_number_key;

-- Add unique constraint per organization (if it doesn't already exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'expenses_transaction_number_org_unique'
  ) THEN
    ALTER TABLE public.expenses 
    ADD CONSTRAINT expenses_transaction_number_org_unique 
    UNIQUE (transaction_number, organization_id);
  END IF;
END $$;

-- ============================================================================
-- PART 6: COMMENTS
-- ============================================================================

COMMENT ON TABLE public.organization_transaction_sequences IS 'Tracks the next transaction number for each organization. Each organization has independent numbering starting from 1.';
COMMENT ON FUNCTION generate_transaction_number(UUID) IS 'Generates the next transaction number for a specific organization. Numbers are unique per organization and start from 00001. Uses SECURITY DEFINER to bypass RLS.';
COMMENT ON FUNCTION assign_transaction_number() IS 'Trigger function that assigns transaction numbers when expenses are submitted. Uses SECURITY DEFINER to call generate_transaction_number.';
COMMENT ON COLUMN public.expenses.transaction_number IS 'Unique 5-digit transaction number per organization for tracking expenses (e.g., 00001, 00002). Each organization has independent numbering.';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Transaction numbers are now per-organization:
-- - Each organization starts from 00001
-- - Organizations have independent sequences
-- - Functions use SECURITY DEFINER to bypass RLS for sequence management
-- - RLS policies allow system functions to manage sequences
-- ============================================================================

