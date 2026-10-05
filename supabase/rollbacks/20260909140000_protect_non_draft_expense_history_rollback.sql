-- Rollback for 20260909140000_protect_non_draft_expense_history.sql
-- Restores the pre-hotfix DELETE policies, allowing a normal authenticated
-- employee to delete their own submitted expense again, and any org admin to
-- delete any expense regardless of status. NOT recommended -- this re-opens
-- the live vulnerability the forward migration closed. Provided only for
-- symmetry/emergency use.

DROP POLICY IF EXISTS "Users can delete their own draft expenses" ON public.expenses;
DROP POLICY IF EXISTS "Admins can delete draft expenses in their organization" ON public.expenses;

CREATE POLICY "Users can delete their own submitted expenses"
ON public.expenses
FOR DELETE
USING (
  uid() = user_id
  AND status = 'submitted'::expense_status
  AND EXISTS (
    SELECT 1 FROM organization_memberships om
    WHERE om.user_id = uid()
      AND om.organization_id = expenses.organization_id
      AND om.is_active = true
  )
);

CREATE POLICY "Admins can delete any expense"
ON public.expenses
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM organization_memberships om
    WHERE om.user_id = uid()
      AND om.organization_id = expenses.organization_id
      AND om.role = 'admin'::app_role
      AND om.is_active = true
  )
);
