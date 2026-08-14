-- Allow users to update their rejected expenses (for resubmission)
-- This enables the resubmission workflow where users can edit and resubmit rejected expenses

-- Drop the old policy
DROP POLICY IF EXISTS "Users can update their submitted expenses" ON public.expenses;

-- Create updated policy that allows editing submitted AND rejected expenses
CREATE POLICY "Users can update their submitted or rejected expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id AND
    status IN ('submitted', 'rejected')
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  )
  WITH CHECK (
    auth.uid() = user_id AND
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  );

COMMENT ON POLICY "Users can update their submitted or rejected expenses" ON public.expenses IS 
  'Allows users to update their own expenses that are in submitted or rejected status. This enables editing and resubmission of rejected expenses.';

