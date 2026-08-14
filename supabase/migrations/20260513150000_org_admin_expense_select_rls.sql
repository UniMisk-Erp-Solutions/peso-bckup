-- Allow org admins (organization_memberships) to SELECT all expenses in their organization.
-- Legacy policy "Admins can view all expenses" only checks user_roles via has_role().

DROP POLICY IF EXISTS "Org admins can view organization expenses" ON public.expenses;

CREATE POLICY "Org admins can view organization expenses"
  ON public.expenses FOR SELECT
  USING (
    expenses.organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

COMMENT ON POLICY "Org admins can view organization expenses" ON public.expenses IS
  'Org-scoped admin SELECT via organization_memberships (complements legacy user_roles has_role admin policy).';
