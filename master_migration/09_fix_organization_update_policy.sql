-- ============================================================================
-- FIX ORGANIZATION UPDATE POLICY
-- ============================================================================
-- Add WITH CHECK clause to organization UPDATE policy

DROP POLICY IF EXISTS "Users can update their own organization" ON public.organizations;
CREATE POLICY "Users can update their own organization"
  ON public.organizations FOR UPDATE
  USING (id = get_user_organization_id() AND has_org_role('admin'))
  WITH CHECK (id = get_user_organization_id() AND has_org_role('admin'));

