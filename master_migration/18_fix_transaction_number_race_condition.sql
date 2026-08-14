-- ============================================================================
-- MIGRATION: Fix Transaction Number Race Condition
-- ============================================================================
-- This migration fixes the race condition that causes duplicate transaction
-- numbers when multiple expenses are created simultaneously.
-- ============================================================================

-- ============================================================================
-- PART 1: DROP AND RECREATE FUNCTION WITH PROPER LOCKING
-- ============================================================================

-- Drop the trigger first (since it depends on the function)
DROP TRIGGER IF EXISTS trigger_assign_transaction_number ON public.expenses;

-- Drop old functions
DROP FUNCTION IF EXISTS assign_transaction_number();
DROP FUNCTION IF EXISTS generate_transaction_number(UUID);

-- Create new function with proper locking to prevent race conditions
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
  -- First ensure row exists
  INSERT INTO public.organization_transaction_sequences (organization_id, next_number, updated_at)
  VALUES (org_id, 1, now())
  ON CONFLICT (organization_id) DO NOTHING;
  
  -- Now lock the row and increment atomically
  -- SELECT FOR UPDATE locks the row, ensuring only one transaction can proceed at a time
  -- This prevents race conditions where multiple transactions read the same value
  PERFORM next_number 
  FROM public.organization_transaction_sequences
  WHERE organization_id = org_id
  FOR UPDATE;
  
  -- Now increment and get the new value
  UPDATE public.organization_transaction_sequences
  SET 
    next_number = next_number + 1,
    updated_at = now()
  WHERE organization_id = org_id
  RETURNING next_number INTO next_num;
  
  -- Format as 5-digit number with leading zeros
  formatted_num := LPAD(next_num::TEXT, 5, '0');
  
  RETURN formatted_num;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION generate_transaction_number(UUID) TO authenticated;

-- ============================================================================
-- PART 2: RECREATE TRIGGER FUNCTION
-- ============================================================================

-- Create new trigger function that uses organization_id
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
-- PART 3: FIX ANY EXISTING DUPLICATE TRANSACTION NUMBERS
-- ============================================================================

DO $$
DECLARE
  org_record RECORD;
  expense_record RECORD;
  org_next_num INTEGER;
  max_txn_num INTEGER;
BEGIN
  -- For each organization, fix duplicate transaction numbers
  FOR org_record IN 
    SELECT DISTINCT organization_id 
    FROM public.expenses 
    WHERE organization_id IS NOT NULL
    ORDER BY organization_id
  LOOP
    -- Find the maximum transaction number for this organization
    SELECT COALESCE(MAX(CAST(transaction_number AS INTEGER)), 0) INTO max_txn_num
    FROM public.expenses
    WHERE organization_id = org_record.organization_id
      AND transaction_number IS NOT NULL
      AND transaction_number ~ '^[0-9]+$';
    
    -- Update the sequence to be at least max_txn_num + 1
    INSERT INTO public.organization_transaction_sequences (organization_id, next_number, updated_at)
    VALUES (org_record.organization_id, GREATEST(max_txn_num + 1, 1), now())
    ON CONFLICT (organization_id) 
    DO UPDATE SET 
      next_number = GREATEST(organization_transaction_sequences.next_number, max_txn_num + 1),
      updated_at = now();
    
    -- Find and fix any duplicate transaction numbers
    -- This will reassign transaction numbers starting from the max + 1
    FOR expense_record IN 
      SELECT id, transaction_number
      FROM public.expenses
      WHERE organization_id = org_record.organization_id
        AND status = 'submitted'
        AND transaction_number IS NOT NULL
        AND id IN (
          -- Find expenses with duplicate transaction numbers
          SELECT id FROM (
            SELECT id, transaction_number,
                   ROW_NUMBER() OVER (PARTITION BY transaction_number ORDER BY created_at) as rn
            FROM public.expenses
            WHERE organization_id = org_record.organization_id
              AND status = 'submitted'
              AND transaction_number IS NOT NULL
          ) dupes
          WHERE rn > 1
        )
      ORDER BY created_at ASC
    LOOP
      -- Generate a new unique transaction number
      max_txn_num := max_txn_num + 1;
      UPDATE public.expenses
      SET transaction_number = LPAD(max_txn_num::TEXT, 5, '0')
      WHERE id = expense_record.id;
    END LOOP;
    
    -- Update sequence to reflect the new max
    UPDATE public.organization_transaction_sequences
    SET next_number = GREATEST(next_number, max_txn_num + 1)
    WHERE organization_id = org_record.organization_id;
    
    RAISE NOTICE 'Fixed transaction numbers for organization %: next number will be %', 
      org_record.organization_id, max_txn_num + 1;
  END LOOP;
END $$;

-- ============================================================================
-- PART 4: VERIFY CONSTRAINT EXISTS
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
-- PART 5: COMMENTS
-- ============================================================================

COMMENT ON FUNCTION generate_transaction_number(UUID) IS 'Generates the next transaction number for a specific organization. Uses SELECT FOR UPDATE to prevent race conditions. Numbers are unique per organization and start from 00001.';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Transaction number generation now uses proper row-level locking to prevent
-- race conditions when multiple expenses are created simultaneously.
-- ============================================================================

