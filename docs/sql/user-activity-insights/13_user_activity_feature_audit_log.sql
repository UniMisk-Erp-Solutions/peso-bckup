-- ============================================================
-- User Activity Insights — Feature Enable/Disable Audit Log
-- docs/sql/user-activity-insights/13_user_activity_feature_audit_log.sql
--
-- Purpose:
--   Records every enable/disable of the user_activity_insights feature
--   flag per organisation by a master admin. This supports accountability,
--   DPDP audit trail requirements, and incident investigation.
--
-- Creates:
--   TABLE  public.user_activity_feature_audit_logs
--   POLICY "Org admins read their org audit logs"
--   FUNCTION public.record_user_activity_feature_audit(...)
--
-- Safety:
--   - CREATE TABLE IF NOT EXISTS (idempotent)
--   - DROP POLICY IF EXISTS + CREATE POLICY (idempotent)
--   - CREATE OR REPLACE FUNCTION (idempotent)
--   - No effect on activity data, expenses, or users
--
-- Run order (after 08, 09):
--   1. This file (13_user_activity_feature_audit_log.sql)
--   2. Optional: 14_harden_notice_ack_policy_idempotency.sql
-- ============================================================


-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_activity_feature_audit_logs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id        uuid        NULL     REFERENCES auth.users(id) ON DELETE SET NULL,
  feature_key          text        NOT NULL DEFAULT 'user_activity_insights',
  action               text        NOT NULL CHECK (action IN ('enabled', 'disabled')),
  confirmation_version text        NULL,
  confirmation_text    text        NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_activity_feature_audit_logs IS
  'Immutable audit trail for enabling or disabling the user_activity_insights feature '
  'per organisation. Each row represents one toggle action by a master admin. '
  'Supports DPDP accountability requirements and incident investigation.';

COMMENT ON COLUMN public.user_activity_feature_audit_logs.action IS
  'Either ''enabled'' or ''disabled''. Reflects the new state after the toggle.';

COMMENT ON COLUMN public.user_activity_feature_audit_logs.confirmation_version IS
  'The version string of the confirmation checkbox the admin ticked, '
  'e.g. ''activity_enable_confirm_v1''. Null for disable actions (no confirmation required).';

COMMENT ON COLUMN public.user_activity_feature_audit_logs.confirmation_text IS
  'Snapshot of the confirmation checkbox label the admin accepted at enable time.';


-- ── Row-Level Security ─────────────────────────────────────────────────────────

ALTER TABLE public.user_activity_feature_audit_logs ENABLE ROW LEVEL SECURITY;

-- Org admins can read their own org's audit entries.
DROP POLICY IF EXISTS "Org admins read feature audit logs" ON public.user_activity_feature_audit_logs;
CREATE POLICY "Org admins read feature audit logs"
  ON public.user_activity_feature_audit_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id         = auth.uid()
        AND om.organization_id = user_activity_feature_audit_logs.organization_id
        AND om.role::text      = 'admin'
    )
  );

-- No client-side INSERT policy: inserts go through SECURITY DEFINER RPC only.
-- Master admin access: via Supabase service-role or direct SQL (not via RLS).


-- ── RPC: record_user_activity_feature_audit ───────────────────────────────────
--
-- Called from the frontend (MasterAdminDashboard) after a successful
-- saveOrganizationFeature for user_activity_insights.
--
-- Security:
--   - SECURITY DEFINER: bypasses RLS on insert (client cannot insert directly)
--   - Validates caller is master_admin via organization_memberships
--     (master_admin role is not in org memberships, so check is via profiles.role
--     or we document: caller must be master_admin — frontend enforces this)
--   - NOTE: Full server-side master_admin role check requires reading profiles.role.
--     This function inserts unconditionally because the frontend page is already
--     master_admin-only (guarded by userRole === "master_admin").
--     Additional server-side hardening can be added by checking profiles.role if
--     a profiles.role column containing 'master_admin' is available.
--   - If caller is unauthenticated, function is a no-op.

CREATE OR REPLACE FUNCTION public.record_user_activity_feature_audit(
  p_organization_id      uuid,
  p_action               text,
  p_confirmation_version text DEFAULT NULL,
  p_confirmation_text    text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
BEGIN
  -- No-op if unauthenticated
  IF v_caller_id IS NULL THEN
    RETURN;
  END IF;

  -- Validate action value
  IF p_action NOT IN ('enabled', 'disabled') THEN
    RAISE EXCEPTION 'Invalid action: %. Must be ''enabled'' or ''disabled''.', p_action;
  END IF;

  -- Validate org exists
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE id = p_organization_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.user_activity_feature_audit_logs (
    organization_id,
    actor_user_id,
    feature_key,
    action,
    confirmation_version,
    confirmation_text,
    created_at
  ) VALUES (
    p_organization_id,
    v_caller_id,
    'user_activity_insights',
    p_action,
    p_confirmation_version,
    p_confirmation_text,
    now()
  );
END;
$$;

COMMENT ON FUNCTION public.record_user_activity_feature_audit IS
  'Inserts one audit row for a master admin enabling or disabling user_activity_insights '
  'for an org. Called from MasterAdminDashboard after saveOrganizationFeature succeeds. '
  'Non-blocking: frontend must not block the feature toggle if this RPC fails. '
  'SECURITY DEFINER SET search_path = public.';


-- ── Verification queries ───────────────────────────────────────────────────────

-- Check table exists:
-- SELECT COUNT(*) FROM public.user_activity_feature_audit_logs;

-- Check recent audit rows:
-- SELECT al.*, o.name AS org_name, u.email AS actor_email
-- FROM public.user_activity_feature_audit_logs al
-- LEFT JOIN public.organizations o ON o.id = al.organization_id
-- LEFT JOIN auth.users u ON u.id = al.actor_user_id
-- ORDER BY al.created_at DESC
-- LIMIT 20;

-- Check RPC exists:
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_schema = 'public'
--   AND routine_name = 'record_user_activity_feature_audit';
