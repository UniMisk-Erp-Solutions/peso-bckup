-- Add category column to expenses table
ALTER TABLE public.expenses 
ADD COLUMN IF NOT EXISTS category TEXT;

-- Add comment to explain the column
COMMENT ON COLUMN public.expenses.category IS 'Expense category name from expense_categories table';

