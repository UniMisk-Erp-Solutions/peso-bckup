-- ============================================================================
-- FIX EXPENSE INSERT RLS POLICY
-- ============================================================================
-- The RLS policy for expense INSERT is failing. This fixes it by using
-- a direct query instead of function calls to avoid NULL handling issues.
-- ============================================================================

-- Drop and recreate the INSERT policy with direct membership check
DROP POLICY IF EXISTS "Employees can create expenses" ON public.expenses;

CREATE POLICY "Employees can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id 
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = organization_id  -- Reference the new row's organization_id
        AND om.is_active = true
        AND om.role IN ('employee', 'engineer', 'admin')  -- Allow employees, engineers (managers), and admins
    )
  );

-- Also ensure the function handles NULL properly
CREATE OR REPLACE FUNCTION has_org_role(_role app_role)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN COALESCE((
    SELECT EXISTS (
      SELECT 1
      FROM public.organization_memberships
      WHERE user_id = auth.uid()
        AND role = _role
        AND is_active = true
    )
  ), false);
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION has_org_role TO authenticated;

