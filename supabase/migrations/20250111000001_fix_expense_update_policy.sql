-- Fix RLS policy to allow users to update submitted expenses (not just draft)
-- Since we changed the workflow to create expenses with status 'submitted' instead of 'draft'

DROP POLICY IF EXISTS "Users can update their draft expenses" ON public.expenses;

CREATE POLICY "Users can update their submitted expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id AND
    status = 'submitted'
  )
  WITH CHECK (
    auth.uid() = user_id AND
    status = 'submitted'
  );

