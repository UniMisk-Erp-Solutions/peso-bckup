-- Allow admins to update approved expenses
-- This enables admins to edit any expense regardless of status

-- Drop existing admin update policy if it exists (if any)
DROP POLICY IF EXISTS "Admins can update any expense" ON public.expenses;

-- Create policy that allows admins to update any expense in their organization
CREATE POLICY "Admins can update any expense"
  ON public.expenses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
    AND organization_id IS NOT NULL
  );

COMMENT ON POLICY "Admins can update any expense" ON public.expenses IS 
  'Allows administrators to update any expense in their organization, including approved expenses. This enables admins to make corrections or adjustments to expenses regardless of their status.';

