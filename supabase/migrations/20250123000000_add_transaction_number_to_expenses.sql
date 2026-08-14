-- Add transaction_number column to expenses table
ALTER TABLE public.expenses 
ADD COLUMN IF NOT EXISTS transaction_number TEXT UNIQUE;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_expenses_transaction_number ON public.expenses(transaction_number);

-- Create a sequence for transaction numbers (starting from 1)
CREATE SEQUENCE IF NOT EXISTS expense_transaction_number_seq START 1;

-- Function to generate next transaction number (5-digit format)
CREATE OR REPLACE FUNCTION generate_transaction_number()
RETURNS TEXT AS $$
DECLARE
  next_num INTEGER;
  formatted_num TEXT;
BEGIN
  -- Get next value from sequence
  next_num := nextval('expense_transaction_number_seq');
  
  -- Format as 5-digit number with leading zeros
  formatted_num := LPAD(next_num::TEXT, 5, '0');
  
  RETURN formatted_num;
END;
$$ LANGUAGE plpgsql;

-- Function to assign transaction number when expense is submitted
CREATE OR REPLACE FUNCTION assign_transaction_number()
RETURNS TRIGGER AS $$
BEGIN
  -- Only assign transaction number when status changes to 'submitted' and transaction_number is NULL
  IF NEW.status = 'submitted' AND (OLD.status IS NULL OR OLD.status != 'submitted') AND NEW.transaction_number IS NULL THEN
    NEW.transaction_number := generate_transaction_number();
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-assign transaction numbers
DROP TRIGGER IF EXISTS trigger_assign_transaction_number ON public.expenses;
CREATE TRIGGER trigger_assign_transaction_number
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION assign_transaction_number();

-- Update existing submitted expenses to have transaction numbers
DO $$
DECLARE
  expense_record RECORD;
  next_num INTEGER;
  max_txn_num INTEGER;
BEGIN
  -- Get the maximum transaction number from existing expenses
  SELECT COALESCE(MAX(CAST(transaction_number AS INTEGER)), 0) INTO max_txn_num
  FROM public.expenses
  WHERE transaction_number IS NOT NULL
    AND transaction_number ~ '^[0-9]+$';
  
  -- Set sequence to next available number (ensure it's at least 1)
  next_num := GREATEST(max_txn_num, 0);
  IF next_num > 0 THEN
    PERFORM setval('expense_transaction_number_seq', next_num, true);
  ELSE
    -- If no existing numbers, start from 1
    PERFORM setval('expense_transaction_number_seq', 1, false);
  END IF;
  
  -- Assign transaction numbers to existing submitted expenses that don't have one
  FOR expense_record IN 
    SELECT id FROM public.expenses 
    WHERE status = 'submitted' AND transaction_number IS NULL
    ORDER BY created_at ASC
  LOOP
    UPDATE public.expenses
    SET transaction_number = LPAD(nextval('expense_transaction_number_seq')::TEXT, 5, '0')
    WHERE id = expense_record.id;
  END LOOP;
END $$;

-- Add comment
COMMENT ON COLUMN public.expenses.transaction_number IS 'Unique 5-digit transaction number for tracking expenses in Tally (e.g., 00001, 00002)';

