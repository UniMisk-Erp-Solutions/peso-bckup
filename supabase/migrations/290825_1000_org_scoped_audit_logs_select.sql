-- Org-scope the admin branch of audit_logs SELECT — found while building the
-- admin submit-for-employee "History" tab, fixed in the same task per explicit
-- user confirmation (not a silent scope expansion).
--
-- The original policy's admin branch used has_role(auth.uid(), 'admin'), a
-- GLOBAL check against public.user_roles with no organization column at all —
-- an admin of ANY organization could read audit_logs rows for expenses
-- belonging to ANY OTHER organization. expenses itself already got the
-- equivalent fix (20260513150000_org_admin_expense_select_rls.sql); audit_logs
-- never did.
--
-- Per this codebase's own documented rule (20260801130000_review_queue_v2_
-- contracts.sql: "NEVER references audit_logs.organization_id directly ...
-- org scope is always inherited from the expense"), scope is enforced by
-- joining through expenses.organization_id + organization_memberships, the
-- exact pattern already used for the expenses fix — not a new pattern.
--
-- Only the admin branch changes. The owner (user_id = auth.uid()) and
-- assigned-engineer (assigned_engineer_id = auth.uid()) branches are
-- reproduced unchanged.

DROP POLICY IF EXISTS "Users can view audit logs of viewable expenses" ON public.audit_logs;

CREATE POLICY "Users can view audit logs of viewable expenses"
  ON public.audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = audit_logs.expense_id
        AND (
          e.user_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
          OR (
            e.organization_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.organization_memberships om
              WHERE om.user_id = auth.uid()
                AND om.organization_id = e.organization_id
                AND om.role = 'admin'
                AND om.is_active = true
            )
          )
        )
    )
  );

COMMENT ON POLICY "Users can view audit logs of viewable expenses" ON public.audit_logs IS
  'Owner and assigned-engineer branches unchanged. Admin branch is now org-scoped via organization_memberships (was: global has_role(admin) check with no org boundary at all — a real cross-tenant read gap).';
