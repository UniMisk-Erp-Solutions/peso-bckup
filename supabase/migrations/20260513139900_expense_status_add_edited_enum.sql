-- Add `edited` to expense_status. MUST be in its own migration/transaction before any use of 'edited'.
-- PostgreSQL error 55P04 if you ADD VALUE and reference 'edited' in the same transaction.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'expense_status' AND e.enumlabel = 'edited'
  ) THEN
    ALTER TYPE public.expense_status ADD VALUE 'edited';
  END IF;
END $$;
