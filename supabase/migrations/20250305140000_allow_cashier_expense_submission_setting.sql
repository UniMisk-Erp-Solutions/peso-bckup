-- ============================================================================
-- ALLOW CASHIER EXPENSE SUBMISSION (organization setting)
-- ============================================================================
-- Adds allow_cashier_expense_submission to organization_settings. When true,
-- cashiers can create and submit expenses; admins can approve them.
-- ============================================================================

-- Add column to organization_settings
ALTER TABLE public.organization_settings
ADD COLUMN IF NOT EXISTS allow_cashier_expense_submission BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.organization_settings.allow_cashier_expense_submission IS
'When true, cashiers in this org can create and submit expense claims; admins can approve them.';

-- Replace expense INSERT policy: allow cashiers when org has the setting enabled
DROP POLICY IF EXISTS "Employees, engineers, and admins can create expenses" ON public.expenses;

CREATE POLICY "Employees, engineers, admins, or cashiers when allowed can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = organization_id
        AND om.is_active = true
        AND (
          om.role IN ('employee', 'engineer', 'admin')
          OR (
            om.role = 'cashier'
            AND EXISTS (
              SELECT 1 FROM public.organization_settings os
              WHERE os.organization_id = organization_id
                AND os.allow_cashier_expense_submission = true
            )
          )
        )
    )
  );
