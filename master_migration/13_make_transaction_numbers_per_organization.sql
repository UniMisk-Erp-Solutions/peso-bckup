-- ============================================================================
-- MIGRATION: Make Transaction Numbers Per-Organization
-- ============================================================================
-- This migration makes transaction numbers unique per organization instead of globally.
-- Each organization will have its own independent sequence starting from 00001.
-- ============================================================================

-- ============================================================================
-- PART 1: CREATE TABLE TO TRACK NEXT TRANSACTION NUMBER PER ORGANIZATION
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

-- RLS Policy: Users can view sequences for their organization
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

-- ============================================================================
-- PART 2: CREATE NEW FUNCTION TO GENERATE TRANSACTION NUMBER PER ORGANIZATION
-- ============================================================================

-- Drop the old function
DROP FUNCTION IF EXISTS generate_transaction_number();

-- Create new function that generates transaction numbers per organization
CREATE OR REPLACE FUNCTION generate_transaction_number(org_id UUID)
RETURNS TEXT AS $$
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
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION generate_transaction_number(UUID) TO authenticated;

-- ============================================================================
-- PART 3: UPDATE TRIGGER FUNCTION TO USE ORGANIZATION_ID
-- ============================================================================

-- Drop the trigger first (since it depends on the function)
DROP TRIGGER IF EXISTS trigger_assign_transaction_number ON public.expenses;

-- Now drop the old trigger function
DROP FUNCTION IF EXISTS assign_transaction_number();

-- Create new trigger function that uses organization_id
CREATE OR REPLACE FUNCTION assign_transaction_number()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

-- Recreate the trigger
CREATE TRIGGER trigger_assign_transaction_number
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION assign_transaction_number();

-- ============================================================================
-- PART 4: MIGRATE EXISTING TRANSACTION NUMBERS TO BE PER-ORGANIZATION
-- ============================================================================

DO $$
DECLARE
  org_record RECORD;
  expense_record RECORD;
  org_next_num INTEGER;
  expense_count INTEGER;
BEGIN
  -- For each organization, reset transaction numbers starting from 00001
  FOR org_record IN 
    SELECT DISTINCT organization_id 
    FROM public.expenses 
    WHERE organization_id IS NOT NULL
    ORDER BY organization_id
  LOOP
    -- Count expenses for this organization that have transaction numbers
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
    DO UPDATE SET next_number = expense_count + 1;
    
    -- Reset transaction numbers for this organization starting from 00001
    -- Process expenses in order of creation
    org_next_num := 1;
    
    FOR expense_record IN 
      SELECT id 
      FROM public.expenses 
      WHERE organization_id = org_record.organization_id
        AND status = 'submitted'
      ORDER BY created_at ASC
    LOOP
      -- Update transaction number to be sequential per organization
      UPDATE public.expenses
      SET transaction_number = LPAD(org_next_num::TEXT, 5, '0')
      WHERE id = expense_record.id;
      
      org_next_num := org_next_num + 1;
    END LOOP;
    
    RAISE NOTICE 'Migrated transaction numbers for organization %: % expenses renumbered starting from 00001', 
      org_record.organization_id, expense_count;
  END LOOP;
END $$;

-- ============================================================================
-- PART 5: VERIFY CONSTRAINT EXISTS (should already exist from previous migration)
-- ============================================================================

-- Ensure the unique constraint is per organization (should already exist)
-- Drop old global unique constraint if it exists
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
COMMENT ON FUNCTION generate_transaction_number(UUID) IS 'Generates the next transaction number for a specific organization. Numbers are unique per organization and start from 00001.';
COMMENT ON COLUMN public.expenses.transaction_number IS 'Unique 5-digit transaction number per organization for tracking expenses (e.g., 00001, 00002). Each organization has independent numbering.';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Transaction numbers are now per-organization:
-- - Each organization starts from 00001
-- - Organizations have independent sequences
-- - Existing transaction numbers have been reset per organization
-- ============================================================================

