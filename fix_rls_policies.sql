-- Fix RLS policies for expense_line_items table
-- Run this in your Supabase Dashboard SQL Editor

-- 1. Drop existing problematic policies
DROP POLICY IF EXISTS "Users can insert line items for their expenses" ON public.expense_line_items;
DROP POLICY IF EXISTS "Users can update line items for their draft expenses" ON public.expense_line_items;
DROP POLICY IF EXISTS "Users can delete line items from their draft expenses" ON public.expense_line_items;

-- 2. Create more permissive policies for expense_line_items
CREATE POLICY "expense_line_items_select_policy"
  ON public.expense_line_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        public.has_role(auth.uid(), 'admin')
      )
    )
  );

CREATE POLICY "expense_line_items_insert_policy"
  ON public.expense_line_items FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "expense_line_items_update_policy"
  ON public.expense_line_items FOR UPDATE
  USING (
    auth.uid() IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "expense_line_items_delete_policy"
  ON public.expense_line_items FOR DELETE
  USING (
    auth.uid() IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
    )
  );

-- 3. Also fix the expenses INSERT policy to be more permissive
DROP POLICY IF EXISTS "Employees can create expenses" ON public.expenses;

CREATE POLICY "expenses_insert_policy"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL AND
    user_id = auth.uid()
  );

-- 4. Verify the policies were created
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies 
WHERE tablename IN ('expense_line_items', 'expenses')
ORDER BY tablename, policyname;
