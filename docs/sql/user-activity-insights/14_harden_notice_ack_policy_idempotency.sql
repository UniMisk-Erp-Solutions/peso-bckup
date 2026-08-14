-- ============================================================
-- User Activity Insights — Harden Acknowledgement Policies (Idempotent)
-- docs/sql/user-activity-insights/14_harden_notice_ack_policy_idempotency.sql
--
-- Purpose:
--   File 08 uses CREATE POLICY without IF NOT EXISTS.
--   If file 08 is accidentally rerun, Postgres will error:
--     "ERROR: 42710: policy already exists"
--   This file re-creates both SELECT policies on
--   user_activity_notice_acknowledgements using DROP IF EXISTS + CREATE,
--   making the operation fully idempotent.
--
-- What this file touches:
--   ONLY RLS SELECT policies on user_activity_notice_acknowledgements.
--
-- What this file does NOT touch:
--   - Activity data (sessions, rollups)
--   - Expenses
--   - Acknowledgement row DATA (only policies, not rows)
--   - Any other table or function
--
-- Run after file 08 (which creates the table and initial policies).
-- Safe to run multiple times.
-- ============================================================


-- ── Harden: "Users read own acknowledgements" ─────────────────────────────────

DROP POLICY IF EXISTS "Users read own acknowledgements"
  ON public.user_activity_notice_acknowledgements;

CREATE POLICY "Users read own acknowledgements"
  ON public.user_activity_notice_acknowledgements
  FOR SELECT
  USING (user_id = auth.uid());


-- ── Harden: "Org admins read org acknowledgements" ────────────────────────────

DROP POLICY IF EXISTS "Org admins read org acknowledgements"
  ON public.user_activity_notice_acknowledgements;

CREATE POLICY "Org admins read org acknowledgements"
  ON public.user_activity_notice_acknowledgements
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id         = auth.uid()
        AND om.organization_id = user_activity_notice_acknowledgements.organization_id
        AND om.role::text      = 'admin'
    )
  );


-- ── Verification ──────────────────────────────────────────────────────────────

-- Confirm both policies exist on the correct table:
SELECT
  policyname,
  tablename,
  cmd,
  permissive
FROM pg_policies
WHERE tablename = 'user_activity_notice_acknowledgements'
ORDER BY policyname;

-- Expected output (2 rows):
--   Org admins read org acknowledgements | user_activity_notice_acknowledgements | SELECT | PERMISSIVE
--   Users read own acknowledgements      | user_activity_notice_acknowledgements | SELECT | PERMISSIVE
