-- Expense delete-safety hotfix: normal application roles must only be able to
-- hard-delete DRAFT expenses. Audit found two live RLS DELETE policies that
-- let a normal authenticated employee delete their own SUBMITTED expense, and
-- let any org admin delete ANY expense regardless of status (approved, paid,
-- etc.) -- both cascade to expense_submission_receipts and audit_logs,
-- silently erasing history. This migration narrows both policies to
-- status = 'draft' only. No other operation (SELECT/INSERT/UPDATE), no FK/
-- cascade behavior, and no other table is touched.

DROP POLICY IF EXISTS "Users can delete their own submitted expenses" ON public.expenses;
DROP POLICY IF EXISTS "Admins can delete any expense" ON public.expenses;

CREATE POLICY "Users can delete their own draft expenses"
ON public.expenses
FOR DELETE
USING (
  uid() = user_id
  AND status = 'draft'::expense_status
  AND EXISTS (
    SELECT 1 FROM organization_memberships om
    WHERE om.user_id = uid()
      AND om.organization_id = expenses.organization_id
      AND om.is_active = true
  )
);

CREATE POLICY "Admins can delete draft expenses in their organization"
ON public.expenses
FOR DELETE
USING (
  status = 'draft'::expense_status
  AND EXISTS (
    SELECT 1 FROM organization_memberships om
    WHERE om.user_id = uid()
      AND om.organization_id = expenses.organization_id
      AND om.role = 'admin'::app_role
      AND om.is_active = true
  )
);
