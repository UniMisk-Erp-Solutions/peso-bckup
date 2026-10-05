-- Org-scope the admin branch of audit_logs SELECT.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- ============================================================================
--
-- SOURCE: Preet-Patel/feature/admin-submit-expense-for-employee, commit
-- 01d60835 (DOC-110), migration 290825_1000_org_scoped_audit_logs_select.sql.
-- Ported here with a conflict-free timestamp in this lineage's own migration
-- chronology (never the source branch's 290825_HHMM_ non-standard naming).
--
-- CLASSIFICATION: still-needed security fix (Category B). Independently
-- confirmed this codebase has the exact same gap the source branch found and
-- fixed: the currently-installed "Users can view audit logs of viewable
-- expenses" policy
-- (supabase/migrations/20251005171552_6159c659-1917-425b-813e-9ef879ba396e.sql,
-- line 288 — read directly, not assumed) has an admin branch using
-- has_role(auth.uid(), 'admin'), a GLOBAL role check against
-- public.user_roles with no organization column at all. An admin of ANY
-- organization can read audit_logs rows for expenses belonging to ANY OTHER
-- organization. The equivalent gap on the expenses table itself was already
-- fixed by 20260513150000_org_admin_expense_select_rls.sql (confirmed
-- present in this repo); audit_logs was never given the same fix.
--
-- WHY THIS MATTERS FOR admin-submit-expense-for-employee SPECIFICALLY: the
-- new Admin Submission History tab (Phase 22/23 of this integration) reads
-- audit_logs rows for admin-submitted expenses. Without this fix, that
-- feature's own read path — and every other admin audit read in this
-- codebase — would depend on a cross-tenant-unsafe policy.
--
-- Per this codebase's own documented rule
-- (20260801130000_review_queue_v2_contracts.sql: "NEVER references
-- audit_logs.organization_id directly ... org scope is always inherited from
-- the expense"), scope is enforced by joining through
-- expenses.organization_id + organization_memberships — the exact pattern
-- 20260513150000 already used for the expenses fix, not a new pattern.
--
-- Only the admin branch changes. The owner (user_id = auth.uid()) and
-- assigned-engineer (assigned_engineer_id = auth.uid()) branches are
-- reproduced unchanged, byte-for-byte, from the currently-installed policy.
-- ============================================================================

BEGIN;

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
  'Owner and assigned-engineer branches unchanged. Admin branch is now org-scoped via organization_memberships (was: global has_role(admin) check with no org boundary at all — a cross-tenant read gap, mirrored from expenses'' own pre-existing fix in 20260513150000_org_admin_expense_select_rls.sql).';

COMMIT;
