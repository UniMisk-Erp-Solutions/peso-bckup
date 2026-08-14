-- ============================================================================
-- BLOCK CASHIERS FROM CREATING EXPENSES
-- ============================================================================
-- This migration updates the expense INSERT RLS policy to explicitly exclude
-- cashiers from creating expenses. Only employees, engineers, and admins
-- should be able to create expenses.
-- ============================================================================

-- Drop the existing policy that allows all organization members to create expenses
DROP POLICY IF EXISTS "Users can create expenses" ON public.expenses;
DROP POLICY IF EXISTS "Employees can create expenses" ON public.expenses;

-- Create a new policy that explicitly excludes cashiers
CREATE POLICY "Employees, engineers, and admins can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = organization_id  -- Reference the new row's organization_id
        AND om.is_active = true
        AND om.role IN ('employee', 'engineer', 'admin')  -- Explicitly exclude 'cashier'
    )
  );

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Cashiers are now blocked from creating expenses at the database level.
-- This prevents them from bypassing UI restrictions by directly accessing
-- the expense form/page or making direct API calls.
-- ============================================================================
