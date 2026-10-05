-- User lifecycle — Phase (this pass): reactivation (currently MISSING —
-- referenced in GRANT/REVOKE statements since DOC-096 but never actually
-- defined anywhere in this repo's migrations, confirmed by a fresh audit
-- of the live function catalog), a deactivation-impact preflight, and an
-- account-level audit event table (audit_logs cannot represent these --
-- its expense_id column is NOT NULL, confirmed by the same audit).
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- Additive only. deactivate_organization_member itself (already correct,
-- already proven, already called from src/) is NOT modified by this
-- migration -- this only adds what was missing alongside it.
-- ============================================================================

-- ── 1. Account-level audit event log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.account_audit_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  target_user_id       uuid NOT NULL,
  actor_user_id        uuid,
  event_type           text NOT NULL,
  reason               text,
  details              jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- auth_ban_failed / auth_unban_failed / auth_sync_recovered: added
  -- during the FINAL ZERO-GAP PASS closure audit -- if the DB-side
  -- deactivate/reactivate succeeds but the companion Auth ban/unban call
  -- (admin-set-user-auth-status Edge Function) fails, that partial-failure
  -- state used to be reported ONLY in the one HTTP response to whichever
  -- admin happened to be watching, with no persistent, queryable record
  -- and no retry path beyond re-running the whole deactivate/reactivate
  -- flow from scratch. record_auth_sync_failure_v1 (service_role only)
  -- now writes a durable, auditable row for it, and the Edge Function's
  -- new `retry_auth_sync` action lets an admin retry ONLY the Auth call
  -- (without re-running the DB-side RPC) and records auth_sync_recovered
  -- on success.
  CONSTRAINT account_audit_events_type_check
    CHECK (event_type IN (
      'user_deactivated', 'user_reactivated',
      'auth_ban_failed', 'auth_unban_failed', 'auth_sync_recovered'
    ))
);

COMMENT ON TABLE public.account_audit_events IS
  'Account-level events (deactivate/reactivate) that public.audit_logs '
  'cannot represent (audit_logs.expense_id is NOT NULL -- expense-scoped '
  'only). Kept deliberately narrow: this is not a general-purpose event '
  'log, only the account-lifecycle events this pass introduces.';

CREATE INDEX IF NOT EXISTS account_audit_events_org_created_idx
  ON public.account_audit_events (organization_id, created_at DESC);

ALTER TABLE public.account_audit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Org admins can see their organization's account audit events"
  ON public.account_audit_events;
CREATE POLICY "Org admins can see their organization's account audit events"
  ON public.account_audit_events FOR SELECT
  USING (public.is_org_admin(organization_id));
REVOKE ALL ON public.account_audit_events FROM PUBLIC;
REVOKE ALL ON public.account_audit_events FROM anon;
GRANT SELECT ON public.account_audit_events TO authenticated;
GRANT ALL ON public.account_audit_events TO service_role;


-- ── 2. Deactivation impact preflight ─────────────────────────────────────────
-- Read-only. Reports CURRENT operational responsibilities that would be
-- left without an active assignee if p_user_id were deactivated right now
-- -- built from the actual schema (reporting_engineer_id / assigned_cashier_id
-- / cashier_assigned_engineer_id on profiles; assigned_engineer_id /
-- assigned_reviewer_id on OPEN expenses; deactivate_organization_member's
-- own "last active admin" guard, surfaced here too so the UI can warn
-- BEFORE the admin attempts (and gets rejected at) the actual deactivation).
CREATE OR REPLACE FUNCTION public.get_user_deactivation_impact_v1(
  p_organization_id uuid,
  p_user_id         uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reports_count       integer;
  v_pending_reviews     integer;
  v_pending_assignments integer;
  v_is_only_active_admin boolean;
  v_target_role         text;
BEGIN
  IF NOT public.is_org_admin(p_organization_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_target_role
  FROM public.organization_memberships
  WHERE organization_id = p_organization_id AND user_id = p_user_id;

  SELECT count(*) INTO v_reports_count
  FROM public.profiles
  WHERE organization_id = p_organization_id
    AND (reporting_engineer_id = p_user_id OR assigned_cashier_id = p_user_id OR cashier_assigned_engineer_id = p_user_id);

  SELECT count(*) INTO v_pending_reviews
  FROM public.expenses
  WHERE organization_id = p_organization_id
    AND assigned_reviewer_id = p_user_id
    AND status NOT IN ('approved', 'rejected');

  SELECT count(*) INTO v_pending_assignments
  FROM public.expenses
  WHERE organization_id = p_organization_id
    AND assigned_engineer_id = p_user_id
    AND status NOT IN ('approved', 'rejected');

  v_is_only_active_admin := false;
  IF v_target_role = 'admin' THEN
    SELECT count(*) = 0 INTO v_is_only_active_admin
    FROM public.organization_memberships
    WHERE organization_id = p_organization_id AND role = 'admin' AND is_active = true AND user_id <> p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'reports_count', v_reports_count,
    'pending_reviews_assigned', v_pending_reviews,
    'pending_expense_assignments', v_pending_assignments,
    'is_only_active_admin', v_is_only_active_admin,
    'blocked', v_is_only_active_admin,
    'reassignment_required', (v_reports_count > 0 OR v_pending_reviews > 0 OR v_pending_assignments > 0)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_user_deactivation_impact_v1(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_deactivation_impact_v1(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_user_deactivation_impact_v1(uuid, uuid) TO authenticated;


-- ── 3. Deactivate wrapper: records the account audit event + optional reason,
--      then delegates the ACTUAL deactivation to the existing, unmodified,
--      already-proven deactivate_organization_member. ─────────────────────
CREATE OR REPLACE FUNCTION public.deactivate_organization_member_v2(
  p_organization_id uuid,
  p_user_id         uuid,
  p_reason          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- deactivate_organization_member itself performs every authorization
  -- check (active-admin caller, target-is-member, not-self,
  -- last-active-admin guard under an advisory lock) -- this wrapper adds
  -- NOTHING to that authorization surface, it only records the event
  -- afterward, so a change here can never weaken what that already-proven
  -- function enforces.
  PERFORM public.deactivate_organization_member(p_organization_id, p_user_id);

  INSERT INTO public.account_audit_events (organization_id, target_user_id, actor_user_id, event_type, reason)
  VALUES (p_organization_id, p_user_id, v_uid, 'user_deactivated', p_reason);

  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.deactivate_organization_member_v2(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deactivate_organization_member_v2(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.deactivate_organization_member_v2(uuid, uuid, text) TO authenticated;


-- ── 4. Reactivate — the genuinely missing function ───────────────────────────
CREATE OR REPLACE FUNCTION public.reactivate_organization_member_v1(
  p_organization_id uuid,
  p_user_id         uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = p_organization_id AND user_id = v_uid AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only organization admins can reactivate members' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships WHERE organization_id = p_organization_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'User is not a member of this organization' USING ERRCODE = '22023';
  END IF;

  -- Same user_id, same profile, same historical data -- never a new
  -- account (task item 37). Current security state (this reactivation
  -- itself) always wins; nothing about a backup/restore or prior state is
  -- consulted here.
  UPDATE public.organization_memberships
  SET is_active = true
  WHERE organization_id = p_organization_id AND user_id = p_user_id;

  UPDATE public.profiles
  SET is_active = true, deactivated_at = NULL, updated_at = now()
  WHERE organization_id = p_organization_id AND user_id = p_user_id;

  INSERT INTO public.account_audit_events (organization_id, target_user_id, actor_user_id, event_type)
  VALUES (p_organization_id, p_user_id, v_uid, 'user_reactivated');

  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.reactivate_organization_member_v1(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reactivate_organization_member_v1(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.reactivate_organization_member_v1(uuid, uuid) TO authenticated;


-- ── 5. Backend enforcement helper: is_active_org_member ──────────────────────
-- Reusable, additive helper -- does NOT replace `is_org_admin` (which
-- already checks organization_memberships.is_active internally and
-- continues to be used unmodified everywhere it already is). This is for
-- call sites that need "any active member", not specifically an admin.
CREATE OR REPLACE FUNCTION public.is_active_org_member(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = p_organization_id AND user_id = auth.uid() AND is_active = true
  );
$$;
REVOKE ALL ON FUNCTION public.is_active_org_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_active_org_member(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_active_org_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_active_org_member(uuid) TO service_role;


-- ── 5b. Auth-sync partial-failure recording + retry support (FINAL
--       ZERO-GAP PASS). service_role-only (called by the Edge Function's
--       service-role client, never directly by a user's own JWT) -- an
--       ordinary admin has no reason to fabricate one of these events.
CREATE OR REPLACE FUNCTION public.record_auth_sync_failure_v1(
  p_organization_id uuid,
  p_target_user_id  uuid,
  p_actor_user_id   uuid,
  p_event_type      text,
  p_error_message_safe text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.account_audit_events (organization_id, target_user_id, actor_user_id, event_type, details)
  VALUES (p_organization_id, p_target_user_id, p_actor_user_id, p_event_type,
    jsonb_build_object('error_message_safe', left(coalesce(p_error_message_safe, ''), 500)));
$$;
REVOKE ALL ON FUNCTION public.record_auth_sync_failure_v1(uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_auth_sync_failure_v1(uuid, uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_auth_sync_failure_v1(uuid, uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_auth_sync_failure_v1(uuid, uuid, uuid, text, text) TO service_role;

-- Lets the Edge Function's retry_auth_sync action determine which
-- direction to retry (ban vs unban) from the CURRENT, authoritative DB
-- state, without re-running deactivate/reactivate. service_role-only --
-- this exposes is_active for a specific member, which authenticated users
-- already see via other already-authorized reads, but this one is scoped
-- to the auth-sync-retry Edge Function's own internal use.
CREATE OR REPLACE FUNCTION public.get_member_active_state_v1(
  p_organization_id uuid,
  p_user_id         uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT is_active FROM public.organization_memberships
  WHERE organization_id = p_organization_id AND user_id = p_user_id;
$$;
REVOKE ALL ON FUNCTION public.get_member_active_state_v1(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_member_active_state_v1(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_member_active_state_v1(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_member_active_state_v1(uuid, uuid) TO service_role;


-- ── 6. Verification ───────────────────────────────────────────────────────────
DO $verify$
BEGIN
  IF to_regclass('public.account_audit_events') IS NULL THEN
    RAISE EXCEPTION 'account_audit_events table missing';
  END IF;
  IF has_table_privilege('anon', 'public.account_audit_events', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not have access to account_audit_events';
  END IF;
  IF has_function_privilege('anon', 'public.reactivate_organization_member_v1(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.deactivate_organization_member_v2(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_user_deactivation_impact_v1(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on user-lifecycle functions';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.reactivate_organization_member_v1(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must have EXECUTE on reactivate_organization_member_v1';
  END IF;
  IF has_function_privilege('authenticated', 'public.record_auth_sync_failure_v1(uuid, uuid, uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_auth_sync_failure_v1(uuid, uuid, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated must not have EXECUTE on record_auth_sync_failure_v1';
  END IF;
  IF has_function_privilege('authenticated', 'public.get_member_active_state_v1(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_member_active_state_v1(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated must not have EXECUTE on get_member_active_state_v1';
  END IF;
  RAISE NOTICE 'user_lifecycle_reactivation_and_impact migration verified OK';
END;
$verify$;
