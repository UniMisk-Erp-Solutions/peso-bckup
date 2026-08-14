-- Allow team leaders and executives to create expenses; broaden hierarchy reviewer SELECT.

DROP POLICY IF EXISTS "Employees, engineers, admins, or cashiers when allowed can create expenses"
  ON public.expenses;

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
          om.role IN ('employee', 'engineer', 'admin', 'team_leader', 'executive')
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

-- Reviewers may read any expense currently assigned to them (tier may change after verify).
DROP POLICY IF EXISTS "Hierarchy reviewers can view assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND (
          (
            om.role = 'team_leader'
            AND (
              (
                expenses.approval_tier = 'team_leader'
                AND (
                  expenses.assigned_reviewer_id = auth.uid()
                  OR expenses.assigned_engineer_id = auth.uid()
                )
              )
              OR expenses.assigned_reviewer_id = auth.uid()
            )
          )
          OR (
            om.role = 'executive'
            AND (
              (
                expenses.approval_tier = 'executive'
                AND (
                  expenses.assigned_reviewer_id = auth.uid()
                  OR expenses.assigned_engineer_id = auth.uid()
                )
              )
              OR expenses.assigned_reviewer_id = auth.uid()
            )
          )
        )
    )
  );

COMMENT ON POLICY "Hierarchy reviewers can view assigned expenses" ON public.expenses IS
  'TL/executive can read expenses at their tier or any expense still assigned to them as reviewer.';
