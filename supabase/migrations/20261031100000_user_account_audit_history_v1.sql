-- DOC-158: immutable USER ACCOUNT audit history (who changed what, on which account, when, from where).
--
-- NOT APPLIED TO PRODUCTION by this PR. Applied manually, once, after review (see Documentations MD/user-account-audit-history.md).
--
-- Design in one paragraph:
--   * One append-only table, public.user_account_audit_events. Every row freezes WHO (actor snapshot), WHAT (field, old, new),
--     ON WHICH ACCOUNT (target snapshot AT THAT MOMENT), WHEN, FROM WHERE (source, request id, execution context).
--   * Mutations are captured by DATABASE TRIGGERS on profiles, organization_memberships, user_roles, team_members,
--     engineer_locations and auth.users, so EVERY path (UI, RPC, edge function, bulk import, legacy SQL) is covered and the
--     business write and its audit row share one transaction (profiles / memberships / roles / teams / locations).
--   * The human actor is taken from the authenticated JWT (auth.uid()). Service-role code paths register a TRUSTED context
--     (service-role-only RPC; the edge function derived the actor from the caller's JWT and checked admin rights) so the
--     human is never replaced by "service_role".  A write with no provable actor is recorded as unattributed, never guessed.
--   * Nothing here stores a password, hash, token, OTP, JWT or session: values are scrubbed on insert and password events carry
--     no value at all.
--   * auth.users triggers never block authentication: a failure there raises a WARNING and the auth operation proceeds.

BEGIN;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. The audit table
-- ---------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_account_audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  target_user_id  uuid NOT NULL,
  actor_user_id   uuid,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','org_admin','master_admin','system','service_role','migration','import','unknown')),
  event_type      text NOT NULL CHECK (event_type IN (
    'baseline_snapshot','user_created','user_deleted','membership_added','membership_removed',
    'profile_updated','email_changed','employee_id_changed','role_changed','legacy_role_changed','accountant_cashier_changed',
    'supervisor_changed','team_changed','cashier_assignment_changed','location_changed','profile_status_changed',
    'organization_changed','master_admin_flag_changed','user_deactivated','user_reactivated','user_banned','user_unbanned',
    'password_changed','password_reset_requested','password_reset_completed','admin_password_reset',
    'account_identity_changed',
    'user_creation_failed','email_change_failed','deactivation_failed','reactivation_failed','password_reset_failed',
    'account_change_denied','auth_ban_failed','auth_unban_failed','auth_sync_recovered')),
  source          text NOT NULL CHECK (source IN (
    'user_management','master_admin','bulk_upload','admin_edge_function','auth_admin','auth_recovery','password_reset',
    'account_settings','self_service','auth_flow','database','system','migration','historical_backfill')),
  request_id      text,
  batch_id        text,
  field_name      text,
  old_value       jsonb,
  new_value       jsonb,
  target_snapshot jsonb,
  actor_snapshot  jsonb,
  metadata        jsonb,
  -- clock_timestamp(), not now(): several events from one transaction must keep their real order in the timeline.
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.user_account_audit_events IS
  'Append-only audit of user-account mutations. target_snapshot/actor_snapshot freeze the identities AT THE TIME of the action; never re-resolve names from current profiles. No password/token data is ever stored.';

CREATE INDEX IF NOT EXISTS idx_uaa_org_created      ON public.user_account_audit_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uaa_target_created   ON public.user_account_audit_events (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uaa_actor_created    ON public.user_account_audit_events (actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uaa_type_created     ON public.user_account_audit_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uaa_request          ON public.user_account_audit_events (request_id) WHERE request_id IS NOT NULL;

-- Immutability: nobody (not the app roles, not the table owner through normal SQL) can UPDATE / DELETE / TRUNCATE a row.
-- Retention/archival, if ever needed, is a separate controlled mechanism that must consciously drop these triggers.
CREATE OR REPLACE FUNCTION public._uaa_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'user_account_audit_events is append-only (% is not allowed)', TG_OP USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS uaa_block_update_delete ON public.user_account_audit_events;
CREATE TRIGGER uaa_block_update_delete BEFORE UPDATE OR DELETE ON public.user_account_audit_events
  FOR EACH ROW EXECUTE FUNCTION public._uaa_block_mutation();
DROP TRIGGER IF EXISTS uaa_block_truncate ON public.user_account_audit_events;
CREATE TRIGGER uaa_block_truncate BEFORE TRUNCATE ON public.user_account_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public._uaa_block_mutation();

REVOKE ALL ON public.user_account_audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.user_account_audit_events TO authenticated, service_role;

ALTER TABLE public.user_account_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS uaa_select_org_admin ON public.user_account_audit_events;
CREATE POLICY uaa_select_org_admin ON public.user_account_audit_events FOR SELECT TO authenticated
  USING ((organization_id IS NOT NULL AND public.is_org_admin(organization_id)) OR public.is_master_admin());
-- No INSERT / UPDATE / DELETE policy exists: rows are written only by the SECURITY DEFINER functions below.
-- (service_role bypasses RLS, but holds no INSERT/UPDATE/DELETE privilege and is blocked by the triggers above.)

-- The pre-existing deactivate/reactivate log is writable by the app role; tighten it (it stays readable and keeps its writers).
REVOKE UPDATE, DELETE, TRUNCATE ON public.account_audit_events FROM authenticated, anon;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Trusted context for service-role code paths (never callable by browsers)
-- ---------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_account_audit_context (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id     uuid NOT NULL,
  organization_id   uuid,
  target_user_id    uuid,
  target_email      text,
  scope             text NOT NULL DEFAULT 'target' CHECK (scope IN ('target','organization')),
  request_id        text NOT NULL,
  batch_id          text,
  source            text NOT NULL,
  method            text,
  execution_context text NOT NULL DEFAULT 'service_role',
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_uaa_ctx_target  ON public.user_account_audit_context (target_user_id, expires_at DESC) WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uaa_ctx_email   ON public.user_account_audit_context (lower(target_email), expires_at DESC) WHERE target_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uaa_ctx_org     ON public.user_account_audit_context (organization_id, expires_at DESC) WHERE scope = 'organization';
REVOKE ALL ON public.user_account_audit_context FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.user_account_audit_context ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Internal helpers (SECURITY DEFINER, not executable by API roles)
-- ---------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._uaa_scrub(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; r jsonb := '{}'::jsonb;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) = 'object' THEN
    FOR k, v IN SELECT * FROM jsonb_each(p) LOOP
      -- secret-looking KEYS are dropped entirely
      IF k ~* '(pass|pwd|secret|token|jwt|otp|hash|api_?key|service_?role|session|credential|cookie|bearer)' THEN CONTINUE; END IF;
      r := r || jsonb_build_object(k, public._uaa_scrub(v));
    END LOOP;
    RETURN r;
  ELSIF jsonb_typeof(p) = 'array' THEN
    RETURN COALESCE((SELECT jsonb_agg(public._uaa_scrub(e)) FROM jsonb_array_elements(p) e), '[]'::jsonb);
  ELSIF jsonb_typeof(p) = 'string' THEN
    -- secret-looking VALUES (JWTs, bcrypt hashes) are redacted
    IF (p #>> '{}') ~ '^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.' OR (p #>> '{}') ~ '^\$2[aby]\$[0-9]{2}\$' THEN
      RETURN to_jsonb('[redacted]'::text);
    END IF;
  END IF;
  RETURN p;
END $$;

CREATE OR REPLACE FUNCTION public._uaa_exec_context() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF((NULLIF(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role', ''),
    session_user::text)
$$;

CREATE OR REPLACE FUNCTION public._uaa_actor_type(p_uid uuid, p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_uid IS NULL THEN 'unknown'
    WHEN EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_uid AND is_master_admin = true)
      OR EXISTS (SELECT 1 FROM public.master_admin_memberships WHERE user_id = p_uid) THEN 'master_admin'
    WHEN EXISTS (SELECT 1 FROM public.organization_memberships WHERE user_id = p_uid AND role = 'admin' AND is_active
                  AND (p_org IS NULL OR organization_id = p_org)) THEN 'org_admin'
    ELSE 'user' END
$$;

CREATE OR REPLACE FUNCTION public._uaa_actor_snapshot(p_uid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_uid IS NULL THEN NULL
    ELSE COALESCE((SELECT jsonb_build_object('user_id', p.user_id, 'name', p.name, 'email', p.email) FROM public.profiles p WHERE p.user_id = p_uid),
                  jsonb_build_object('user_id', p_uid)) END
$$;

CREATE OR REPLACE FUNCTION public._uaa_role_of(p_uid uuid, p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT role::text FROM public.organization_memberships WHERE user_id = p_uid AND (p_org IS NULL OR organization_id = p_org) LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public._uaa_org_of(p_uid uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT organization_id FROM public.profiles WHERE user_id = p_uid),
                  (SELECT organization_id FROM public.organization_memberships WHERE user_id = p_uid LIMIT 1))
$$;

-- Who is acting?  Order of trust: (1) the authenticated JWT, (2) a context registered by trusted server code, (3) unattributed.
CREATE OR REPLACE FUNCTION public._uaa_resolve(p_org uuid, p_target uuid, p_email text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_exec text := public._uaa_exec_context(); c public.user_account_audit_context%ROWTYPE; v_human boolean;
        v_email text := p_email;
BEGIN
  v_human := v_uid IS NOT NULL AND v_exec <> 'service_role';
  -- At account-creation time only the e-mail is known to the caller (the auth user id is created inside GoTrue), and some
  -- rows (e.g. the membership inserted by handle_new_user) are written before any id-keyed context exists. Match by e-mail.
  IF v_email IS NULL AND p_target IS NOT NULL THEN
    SELECT email INTO v_email FROM public.profiles WHERE user_id = p_target;
  END IF;
  SELECT * INTO c FROM public.user_account_audit_context x
   WHERE x.expires_at > now()
     AND ( (x.scope = 'target' AND (x.target_user_id = p_target
             OR (x.target_user_id IS NULL AND v_email IS NOT NULL AND lower(x.target_email) = lower(v_email))))
        OR (x.scope = 'organization' AND p_org IS NOT NULL AND x.organization_id = p_org AND NOT v_human) )
     AND ( NOT v_human OR x.actor_user_id = v_uid )
   ORDER BY (x.scope = 'target') DESC, x.created_at DESC LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('actor', c.actor_user_id, 'actor_type', public._uaa_actor_type(c.actor_user_id, COALESCE(p_org, c.organization_id)),
      'source', c.source, 'request_id', c.request_id, 'batch_id', c.batch_id, 'method', c.method,
      'execution', CASE WHEN v_human THEN 'authenticated' ELSE c.execution_context END, 'attribution', 'trusted_context');
  END IF;
  IF v_human THEN
    RETURN jsonb_build_object('actor', v_uid, 'actor_type', public._uaa_actor_type(v_uid, p_org),
      'source', CASE WHEN v_uid = p_target THEN 'self_service' ELSE 'user_management' END,
      'request_id', 'tx:' || txid_current()::text, 'execution', 'authenticated', 'attribution', 'jwt');
  END IF;
  RETURN jsonb_build_object('actor', NULL, 'actor_type', CASE WHEN v_exec = 'service_role' THEN 'service_role' ELSE 'system' END,
    'source', CASE WHEN session_user::text IN ('supabase_auth_admin') THEN 'auth_flow' ELSE 'database' END,
    'request_id', 'tx:' || txid_current()::text, 'execution', v_exec, 'attribution', 'unattributed');
END $$;

CREATE OR REPLACE FUNCTION public._uaa_emit(
  p_org uuid, p_target uuid, p_event_type text, p_field text, p_old jsonb, p_new jsonb,
  p_snapshot jsonb, p_meta jsonb DEFAULT NULL, p_email_for_ctx text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; v_id uuid := gen_random_uuid(); v_actor uuid; v_meta jsonb;
BEGIN
  r := public._uaa_resolve(p_org, p_target, p_email_for_ctx);
  v_actor := NULLIF(r ->> 'actor', '')::uuid;
  v_meta := COALESCE(p_meta, '{}'::jsonb)
         || jsonb_build_object('execution_context', r ->> 'execution', 'attribution', r ->> 'attribution')
         || CASE WHEN r ->> 'method' IS NOT NULL THEN jsonb_build_object('method', r ->> 'method') ELSE '{}'::jsonb END;
  INSERT INTO public.user_account_audit_events
    (id, organization_id, target_user_id, actor_user_id, actor_type, event_type, source, request_id, batch_id,
     field_name, old_value, new_value, target_snapshot, actor_snapshot, metadata)
  VALUES
    (v_id, p_org, p_target, v_actor, r ->> 'actor_type', p_event_type, r ->> 'source', r ->> 'request_id', r ->> 'batch_id',
     p_field, public._uaa_scrub(p_old), public._uaa_scrub(p_new), public._uaa_scrub(p_snapshot),
     public._uaa_scrub(public._uaa_actor_snapshot(v_actor)), public._uaa_scrub(v_meta));
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public._uaa_scrub(jsonb), public._uaa_exec_context(), public._uaa_actor_type(uuid, uuid), public._uaa_actor_snapshot(uuid),
  public._uaa_role_of(uuid, uuid), public._uaa_org_of(uuid), public._uaa_resolve(uuid, uuid, text),
  public._uaa_emit(uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, text), public._uaa_block_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Triggers on the mutation points
-- ---------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._uaa_label_user(p uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT name FROM public.profiles WHERE user_id = p $$;
REVOKE ALL ON FUNCTION public._uaa_label_user(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- profiles --------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._uaa_trg_profiles() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s jsonb; o public.profiles%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    s := jsonb_build_object('name', NEW.name, 'email', NEW.email, 'employee_id', NEW.employee_id,
                            'role', public._uaa_role_of(NEW.user_id, NEW.organization_id), 'organization_id', NEW.organization_id, 'profile_active', NEW.is_active);
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'user_created', NULL, NULL, NULL, s, jsonb_build_object('layer', 'profile'), NEW.email);
    RETURN NULL;
  ELSIF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN  -- direct delete; a cascade from auth.users is already reported by that trigger
      s := jsonb_build_object('name', OLD.name, 'email', OLD.email, 'employee_id', OLD.employee_id, 'organization_id', OLD.organization_id);
      PERFORM public._uaa_emit(OLD.organization_id, OLD.user_id, 'user_deleted', NULL, NULL, NULL, s, jsonb_build_object('layer', 'profile'));
    END IF;
    RETURN NULL;
  END IF;

  o := OLD;
  -- The snapshot is the identity BEFORE the change (who the account was when the action happened).
  s := jsonb_build_object('name', o.name, 'email', o.email, 'employee_id', o.employee_id,
                          'role', public._uaa_role_of(o.user_id, o.organization_id), 'organization_id', o.organization_id, 'profile_active', o.is_active);
  IF NEW.name IS DISTINCT FROM o.name THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'profile_updated', 'name', to_jsonb(o.name), to_jsonb(NEW.name), s);
  END IF;
  IF NEW.email IS DISTINCT FROM o.email THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'email_changed', 'email', to_jsonb(o.email), to_jsonb(NEW.email), s, jsonb_build_object('layer', 'profile'));
  END IF;
  IF NEW.employee_id IS DISTINCT FROM o.employee_id THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'employee_id_changed', 'employee_id', to_jsonb(o.employee_id), to_jsonb(NEW.employee_id), s);
  END IF;
  IF NEW.reporting_engineer_id IS DISTINCT FROM o.reporting_engineer_id THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'supervisor_changed', 'reporting_engineer_id', to_jsonb(o.reporting_engineer_id), to_jsonb(NEW.reporting_engineer_id), s,
      jsonb_build_object('old_label', public._uaa_label_user(o.reporting_engineer_id), 'new_label', public._uaa_label_user(NEW.reporting_engineer_id)));
  END IF;
  IF NEW.assigned_cashier_id IS DISTINCT FROM o.assigned_cashier_id THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'cashier_assignment_changed', 'assigned_cashier_id', to_jsonb(o.assigned_cashier_id), to_jsonb(NEW.assigned_cashier_id), s,
      jsonb_build_object('old_label', public._uaa_label_user(o.assigned_cashier_id), 'new_label', public._uaa_label_user(NEW.assigned_cashier_id)));
  END IF;
  IF NEW.cashier_assigned_engineer_id IS DISTINCT FROM o.cashier_assigned_engineer_id THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'cashier_assignment_changed', 'cashier_assigned_engineer_id', to_jsonb(o.cashier_assigned_engineer_id), to_jsonb(NEW.cashier_assigned_engineer_id), s,
      jsonb_build_object('old_label', public._uaa_label_user(o.cashier_assigned_engineer_id), 'new_label', public._uaa_label_user(NEW.cashier_assigned_engineer_id)));
  END IF;
  IF NEW.cashier_assigned_location_id IS DISTINCT FROM o.cashier_assigned_location_id THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'cashier_assignment_changed', 'cashier_assigned_location_id', to_jsonb(o.cashier_assigned_location_id), to_jsonb(NEW.cashier_assigned_location_id), s,
      jsonb_build_object('old_label', (SELECT name FROM public.locations WHERE id = o.cashier_assigned_location_id), 'new_label', (SELECT name FROM public.locations WHERE id = NEW.cashier_assigned_location_id)));
  END IF;
  IF NEW.is_active IS DISTINCT FROM o.is_active THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'profile_status_changed', 'profile.is_active', to_jsonb(o.is_active), to_jsonb(NEW.is_active), s,
      jsonb_build_object('layer', 'profile'));
  END IF;
  IF NEW.organization_id IS DISTINCT FROM o.organization_id THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'organization_changed', 'organization_id', to_jsonb(o.organization_id), to_jsonb(NEW.organization_id), s);
  END IF;
  IF NEW.is_master_admin IS DISTINCT FROM o.is_master_admin THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'master_admin_flag_changed', 'is_master_admin', to_jsonb(o.is_master_admin), to_jsonb(NEW.is_master_admin), s);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS uaa_profiles_ins ON public.profiles;
CREATE TRIGGER uaa_profiles_ins AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public._uaa_trg_profiles();
DROP TRIGGER IF EXISTS uaa_profiles_del ON public.profiles;
CREATE TRIGGER uaa_profiles_del AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public._uaa_trg_profiles();
DROP TRIGGER IF EXISTS uaa_profiles_upd ON public.profiles;
-- The WHEN clause keeps hot paths (balance, notification and language updates) from invoking the trigger at all.
CREATE TRIGGER uaa_profiles_upd AFTER UPDATE ON public.profiles FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.email IS DISTINCT FROM NEW.email OR OLD.employee_id IS DISTINCT FROM NEW.employee_id
     OR OLD.reporting_engineer_id IS DISTINCT FROM NEW.reporting_engineer_id OR OLD.assigned_cashier_id IS DISTINCT FROM NEW.assigned_cashier_id
     OR OLD.cashier_assigned_engineer_id IS DISTINCT FROM NEW.cashier_assigned_engineer_id
     OR OLD.cashier_assigned_location_id IS DISTINCT FROM NEW.cashier_assigned_location_id
     OR OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
     OR OLD.is_master_admin IS DISTINCT FROM NEW.is_master_admin)
  EXECUTE FUNCTION public._uaa_trg_profiles();

-- organization_memberships ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._uaa_trg_memberships() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s jsonb; p public.profiles%ROWTYPE; v_banned boolean; v_meta jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO p FROM public.profiles WHERE user_id = NEW.user_id;
    s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id, 'role', NEW.role::text, 'organization_id', NEW.organization_id);
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'membership_added', 'role', NULL, to_jsonb(NEW.role::text), s,
      jsonb_build_object('membership_active', NEW.is_active, 'is_accountant_cashier', NEW.is_accountant_cashier));
    RETURN NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT * INTO p FROM public.profiles WHERE user_id = OLD.user_id;
    s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id, 'role', OLD.role::text, 'organization_id', OLD.organization_id);
    PERFORM public._uaa_emit(OLD.organization_id, OLD.user_id, 'membership_removed', 'role', to_jsonb(OLD.role::text), NULL, s,
      jsonb_build_object('membership_active', OLD.is_active));
    RETURN NULL;
  END IF;

  SELECT * INTO p FROM public.profiles WHERE user_id = NEW.user_id;
  s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id, 'role', OLD.role::text, 'organization_id', OLD.organization_id);
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'role_changed', 'role', to_jsonb(OLD.role::text), to_jsonb(NEW.role::text), s);
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    -- The three "off" switches are different things: this event records the MEMBERSHIP transition, and carries the other two
    -- states as they were at that moment so they are never conflated.
    SELECT (u.banned_until IS NOT NULL AND u.banned_until > now()) INTO v_banned FROM auth.users u WHERE u.id = NEW.user_id;
    v_meta := jsonb_build_object('layer', 'membership', 'membership_active', jsonb_build_object('old', OLD.is_active, 'new', NEW.is_active),
                                 'profile_active', p.is_active, 'auth_banned', COALESCE(v_banned, false), 'role', NEW.role::text);
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, CASE WHEN NEW.is_active THEN 'user_reactivated' ELSE 'user_deactivated' END,
      'membership.is_active', to_jsonb(OLD.is_active), to_jsonb(NEW.is_active), s, v_meta);
  END IF;
  IF NEW.is_accountant_cashier IS DISTINCT FROM OLD.is_accountant_cashier THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'accountant_cashier_changed', 'is_accountant_cashier', to_jsonb(OLD.is_accountant_cashier), to_jsonb(NEW.is_accountant_cashier), s);
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    PERFORM public._uaa_emit(NEW.organization_id, NEW.user_id, 'organization_changed', 'membership.organization_id', to_jsonb(OLD.organization_id), to_jsonb(NEW.organization_id), s);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS uaa_memberships_ins ON public.organization_memberships;
CREATE TRIGGER uaa_memberships_ins AFTER INSERT ON public.organization_memberships FOR EACH ROW EXECUTE FUNCTION public._uaa_trg_memberships();
DROP TRIGGER IF EXISTS uaa_memberships_del ON public.organization_memberships;
CREATE TRIGGER uaa_memberships_del AFTER DELETE ON public.organization_memberships FOR EACH ROW EXECUTE FUNCTION public._uaa_trg_memberships();
DROP TRIGGER IF EXISTS uaa_memberships_upd ON public.organization_memberships;
CREATE TRIGGER uaa_memberships_upd AFTER UPDATE ON public.organization_memberships FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.is_active IS DISTINCT FROM NEW.is_active
     OR OLD.is_accountant_cashier IS DISTINCT FROM NEW.is_accountant_cashier OR OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION public._uaa_trg_memberships();

-- user_roles (legacy table). Rows written BY the membership-sync trigger are derived and already reported as role_changed,
-- so only DIRECT writes (trigger depth 1) are recorded here.
CREATE OR REPLACE FUNCTION public._uaa_trg_user_roles() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid; v_old text; v_new text; s jsonb; p public.profiles%ROWTYPE;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  v_uid := COALESCE(NEW.user_id, OLD.user_id);
  IF TG_OP <> 'INSERT' THEN v_old := OLD.role::text; END IF;
  IF TG_OP <> 'DELETE' THEN v_new := NEW.role::text; END IF;
  IF v_old IS NOT DISTINCT FROM v_new THEN RETURN NULL; END IF;
  SELECT * INTO p FROM public.profiles WHERE user_id = v_uid;
  s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id, 'organization_id', p.organization_id);
  PERFORM public._uaa_emit(p.organization_id, v_uid, 'legacy_role_changed', 'user_roles.role', to_jsonb(v_old), to_jsonb(v_new), s,
    jsonb_build_object('layer', 'user_roles'));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS uaa_user_roles ON public.user_roles;
CREATE TRIGGER uaa_user_roles AFTER INSERT OR UPDATE OR DELETE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public._uaa_trg_user_roles();

-- team_members / engineer_locations (a "move" is a delete + insert in one transaction and shares one request id) ---------------
CREATE OR REPLACE FUNCTION public._uaa_trg_team_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.team_members%ROWTYPE; p public.profiles%ROWTYPE; s jsonb; v_label text;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO p FROM public.profiles WHERE user_id = r.user_id;
  s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id, 'role', public._uaa_role_of(r.user_id, r.organization_id), 'organization_id', r.organization_id);
  SELECT name INTO v_label FROM public.teams WHERE id = r.team_id;
  IF TG_OP = 'DELETE' THEN
    PERFORM public._uaa_emit(r.organization_id, r.user_id, 'team_changed', 'team_id', to_jsonb(r.team_id), NULL, s, jsonb_build_object('old_label', v_label, 'change', 'left_team'));
  ELSE
    PERFORM public._uaa_emit(r.organization_id, r.user_id, 'team_changed', 'team_id', NULL, to_jsonb(r.team_id), s, jsonb_build_object('new_label', v_label, 'change', 'joined_team'));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS uaa_team_members ON public.team_members;
CREATE TRIGGER uaa_team_members AFTER INSERT OR DELETE ON public.team_members FOR EACH ROW EXECUTE FUNCTION public._uaa_trg_team_members();

CREATE OR REPLACE FUNCTION public._uaa_trg_engineer_locations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.engineer_locations%ROWTYPE; p public.profiles%ROWTYPE; s jsonb; v_label text;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO p FROM public.profiles WHERE user_id = r.engineer_id;
  s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id, 'role', public._uaa_role_of(r.engineer_id, r.organization_id), 'organization_id', r.organization_id);
  SELECT name INTO v_label FROM public.locations WHERE id = r.location_id;
  IF TG_OP = 'DELETE' THEN
    PERFORM public._uaa_emit(r.organization_id, r.engineer_id, 'location_changed', 'location_id', to_jsonb(r.location_id), NULL, s, jsonb_build_object('old_label', v_label, 'change', 'removed'));
  ELSE
    PERFORM public._uaa_emit(r.organization_id, r.engineer_id, 'location_changed', 'location_id', NULL, to_jsonb(r.location_id), s, jsonb_build_object('new_label', v_label, 'change', 'assigned'));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS uaa_engineer_locations ON public.engineer_locations;
CREATE TRIGGER uaa_engineer_locations AFTER INSERT OR DELETE ON public.engineer_locations FOR EACH ROW EXECUTE FUNCTION public._uaa_trg_engineer_locations();

-- auth.users: email, ban and password transitions.  NEVER blocks authentication: any failure is a WARNING only.
-- Password events carry NO value, hash or timestamp-of-secret: only the fact that it changed.
CREATE OR REPLACE FUNCTION public._uaa_trg_auth_users() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.profiles%ROWTYPE; s jsonb; v_org uuid; v_old_ban boolean; v_new_ban boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    s := jsonb_build_object('email', OLD.email);
    PERFORM public._uaa_emit(public._uaa_org_of(OLD.id), OLD.id, 'user_deleted', NULL, NULL, NULL, s, jsonb_build_object('layer', 'auth'));
    RETURN OLD;  -- BEFORE DELETE: the row must proceed
  END IF;
  SELECT * INTO p FROM public.profiles WHERE user_id = NEW.id;
  v_org := COALESCE(p.organization_id, public._uaa_org_of(NEW.id));
  s := jsonb_build_object('name', p.name, 'email', COALESCE(p.email, OLD.email), 'employee_id', p.employee_id,
                          'role', public._uaa_role_of(NEW.id, v_org), 'organization_id', v_org);
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    PERFORM public._uaa_emit(v_org, NEW.id, 'email_changed', 'auth.email', to_jsonb(OLD.email), to_jsonb(NEW.email), s, jsonb_build_object('layer', 'auth'));
  END IF;
  v_old_ban := OLD.banned_until IS NOT NULL AND OLD.banned_until > now();
  v_new_ban := NEW.banned_until IS NOT NULL AND NEW.banned_until > now();
  IF v_old_ban IS DISTINCT FROM v_new_ban THEN
    PERFORM public._uaa_emit(v_org, NEW.id, CASE WHEN v_new_ban THEN 'user_banned' ELSE 'user_unbanned' END, 'auth.banned',
      to_jsonb(v_old_ban), to_jsonb(v_new_ban), s, jsonb_build_object('layer', 'auth', 'profile_active', p.is_active));
  END IF;
  IF NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password THEN
    PERFORM public._uaa_emit(v_org, NEW.id, 'password_changed', NULL, NULL, NULL, s, jsonb_build_object('layer', 'auth'));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'user_account_audit: auth.users audit failed (%), authentication proceeds', SQLERRM;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS uaa_auth_users_upd ON auth.users;
CREATE TRIGGER uaa_auth_users_upd AFTER UPDATE ON auth.users FOR EACH ROW
  WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.banned_until IS DISTINCT FROM NEW.banned_until OR OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password)
  EXECUTE FUNCTION public._uaa_trg_auth_users();
DROP TRIGGER IF EXISTS uaa_auth_users_del ON auth.users;
-- BEFORE DELETE so the profile/membership still exist (the FK cascade would remove them first) and the organization is known.
CREATE TRIGGER uaa_auth_users_del BEFORE DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION public._uaa_trg_auth_users();

REVOKE ALL ON FUNCTION public._uaa_trg_profiles(), public._uaa_trg_memberships(), public._uaa_trg_user_roles(), public._uaa_trg_team_members(),
  public._uaa_trg_engineer_locations(), public._uaa_trg_auth_users() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Service-role-only RPCs: register the REAL human actor, record explicit events
-- ---------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_user_account_audit_context_v1(
  p_actor_user_id uuid, p_organization_id uuid, p_request_id text, p_source text,
  p_target_user_ids uuid[] DEFAULT NULL, p_target_email text DEFAULT NULL, p_batch_id text DEFAULT NULL,
  p_scope text DEFAULT 'target', p_ttl_seconds int DEFAULT 120, p_method text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t uuid; v_ttl int := LEAST(GREATEST(COALESCE(p_ttl_seconds, 120), 5), 3600);
BEGIN
  IF public._uaa_exec_context() <> 'service_role' THEN RAISE EXCEPTION 'service role only' USING ERRCODE = '42501'; END IF;
  IF p_scope NOT IN ('target', 'organization') THEN RAISE EXCEPTION 'invalid scope'; END IF;
  IF p_request_id IS NULL OR length(p_request_id) = 0 THEN RAISE EXCEPTION 'request id required'; END IF;
  IF p_source NOT IN ('user_management','master_admin','bulk_upload','admin_edge_function','auth_admin','auth_recovery','password_reset','account_settings','self_service','system') THEN
    RAISE EXCEPTION 'invalid source';
  END IF;
  -- Defence in depth: even though the edge function already authorised the caller, the actor must really be an active admin
  -- of that organization (or a master admin). A spoofed actor id cannot be registered.
  IF public._uaa_actor_type(p_actor_user_id, p_organization_id) NOT IN ('org_admin', 'master_admin')
     AND NOT (p_source IN ('account_settings', 'auth_recovery') AND p_target_user_ids = ARRAY[p_actor_user_id]) THEN
    RAISE EXCEPTION 'actor is not an administrator of this organization' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.user_account_audit_context WHERE expires_at < now() - interval '1 day';
  IF p_scope = 'organization' THEN
    INSERT INTO public.user_account_audit_context (actor_user_id, organization_id, scope, request_id, batch_id, source, method, expires_at)
    VALUES (p_actor_user_id, p_organization_id, 'organization', p_request_id, p_batch_id, p_source, p_method, now() + make_interval(secs => v_ttl));
  ELSE
    IF p_target_user_ids IS NOT NULL THEN
      FOREACH t IN ARRAY p_target_user_ids LOOP
        INSERT INTO public.user_account_audit_context (actor_user_id, organization_id, target_user_id, scope, request_id, batch_id, source, method, expires_at)
        VALUES (p_actor_user_id, p_organization_id, t, 'target', p_request_id, p_batch_id, p_source, p_method, now() + make_interval(secs => v_ttl));
      END LOOP;
    END IF;
    IF p_target_email IS NOT NULL THEN
      INSERT INTO public.user_account_audit_context (actor_user_id, organization_id, target_email, scope, request_id, batch_id, source, method, expires_at)
      VALUES (p_actor_user_id, p_organization_id, lower(p_target_email), 'target', p_request_id, p_batch_id, p_source, p_method, now() + make_interval(secs => v_ttl));
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.clear_user_account_audit_context_v1(p_request_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public._uaa_exec_context() <> 'service_role' THEN RAISE EXCEPTION 'service role only' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.user_account_audit_context WHERE request_id = p_request_id;
END $$;

-- Explicit events that no table trigger can see (password operations, failures, denials).  The actor is validated against real
-- profiles and ITS TYPE IS COMPUTED SERVER-SIDE; the target snapshot is read from the database, not from the caller.
CREATE OR REPLACE FUNCTION public.record_user_account_audit_event_v1(
  p_organization_id uuid, p_target_user_id uuid, p_actor_user_id uuid, p_event_type text, p_source text, p_request_id text,
  p_metadata jsonb DEFAULT NULL, p_field_name text DEFAULT NULL, p_old_value jsonb DEFAULT NULL, p_new_value jsonb DEFAULT NULL,
  p_batch_id text DEFAULT NULL, p_execution_context text DEFAULT 'service_role'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.profiles%ROWTYPE; s jsonb; v_id uuid := gen_random_uuid(); v_actor_ok boolean;
BEGIN
  IF public._uaa_exec_context() <> 'service_role' THEN RAISE EXCEPTION 'service role only' USING ERRCODE = '42501'; END IF;
  IF p_event_type NOT IN ('password_reset_requested','password_reset_completed','admin_password_reset','password_changed',
        'user_creation_failed','email_change_failed','deactivation_failed','reactivation_failed','password_reset_failed',
        'account_change_denied','auth_ban_failed','auth_unban_failed','auth_sync_recovered','account_identity_changed') THEN
    RAISE EXCEPTION 'event type % is recorded by triggers or is not allowed here', p_event_type;
  END IF;
  IF p_source NOT IN ('user_management','master_admin','bulk_upload','admin_edge_function','auth_admin','auth_recovery','password_reset','account_settings','self_service','system') THEN
    RAISE EXCEPTION 'invalid source';
  END IF;
  IF p_actor_user_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_actor_user_id) INTO v_actor_ok;
    IF NOT v_actor_ok THEN RAISE EXCEPTION 'unknown actor' USING ERRCODE = '42501'; END IF;
  END IF;
  SELECT * INTO p FROM public.profiles WHERE user_id = p_target_user_id;
  s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id,
                          'role', public._uaa_role_of(p_target_user_id, p_organization_id), 'organization_id', COALESCE(p_organization_id, p.organization_id));
  INSERT INTO public.user_account_audit_events
    (id, organization_id, target_user_id, actor_user_id, actor_type, event_type, source, request_id, batch_id, field_name,
     old_value, new_value, target_snapshot, actor_snapshot, metadata)
  VALUES
    (v_id, COALESCE(p_organization_id, p.organization_id), p_target_user_id, p_actor_user_id,
     CASE WHEN p_actor_user_id IS NULL THEN 'system' ELSE public._uaa_actor_type(p_actor_user_id, p_organization_id) END,
     p_event_type, p_source, p_request_id, p_batch_id, p_field_name,
     public._uaa_scrub(p_old_value), public._uaa_scrub(p_new_value), public._uaa_scrub(s),
     public._uaa_scrub(public._uaa_actor_snapshot(p_actor_user_id)),
     public._uaa_scrub(COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('execution_context', p_execution_context)));
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.register_user_account_audit_context_v1(uuid, uuid, text, text, uuid[], text, text, text, int, text),
  public.clear_user_account_audit_context_v1(text),
  public.record_user_account_audit_event_v1(uuid, uuid, uuid, text, text, text, jsonb, text, jsonb, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_user_account_audit_context_v1(uuid, uuid, text, text, uuid[], text, text, text, int, text),
  public.clear_user_account_audit_context_v1(text),
  public.record_user_account_audit_event_v1(uuid, uuid, uuid, text, text, text, jsonb, text, jsonb, jsonb, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Authenticated RPCs (actor ALWAYS derived from auth.uid(), never from a parameter)
-- ---------------------------------------------------------------------------------------------------------------------------
-- A signed-in user registers "I am about to change MY OWN password/email from account settings" so the trigger attributes it.
CREATE OR REPLACE FUNCTION public.register_my_account_audit_context_v1(p_source text DEFAULT 'account_settings', p_method text DEFAULT 'self_service')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_source NOT IN ('account_settings', 'auth_recovery') THEN RAISE EXCEPTION 'invalid source'; END IF;
  DELETE FROM public.user_account_audit_context WHERE expires_at < now() - interval '1 day';
  INSERT INTO public.user_account_audit_context (actor_user_id, organization_id, target_user_id, scope, request_id, source, method, execution_context, expires_at)
  VALUES (v_uid, public._uaa_org_of(v_uid), v_uid, 'target', 'self:' || gen_random_uuid()::text, p_source, left(COALESCE(p_method, 'self_service'), 40),
          'authenticated', now() + interval '120 seconds');
END $$;

CREATE OR REPLACE FUNCTION public._uaa_assert_org_admin_of_target(p_org uuid, p_target uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT (public.is_org_admin(p_org) OR public.is_master_admin()) THEN
    RAISE EXCEPTION 'only an administrator of this organization may do this' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_memberships WHERE organization_id = p_org AND user_id = p_target) THEN
    RAISE EXCEPTION 'user is not a member of this organization' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._uaa_assert_org_admin_of_target(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- How much history rides on this account?  Used by the "name + email at once" reassignment warning.
CREATE OR REPLACE FUNCTION public.get_user_identity_history_summary_v1(p_organization_id uuid, p_target_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_expenses bigint; v_audit bigint; v_ledger bigint; v_batches bigint; v_created timestamptz; v_first timestamptz; v_events bigint;
BEGIN
  PERFORM public._uaa_assert_org_admin_of_target(p_organization_id, p_target_user_id);
  SELECT count(*), min(created_at) INTO v_expenses, v_first FROM public.expenses WHERE user_id = p_target_user_id AND organization_id = p_organization_id;
  SELECT count(*) INTO v_audit   FROM public.audit_logs WHERE user_id = p_target_user_id;
  SELECT count(*) INTO v_ledger  FROM public.balance_ledger WHERE user_id = p_target_user_id;
  SELECT count(*) INTO v_batches FROM public.expense_batches WHERE user_id = p_target_user_id;
  SELECT count(*) INTO v_events  FROM public.user_account_audit_events WHERE target_user_id = p_target_user_id AND event_type <> 'baseline_snapshot';
  SELECT created_at INTO v_created FROM public.profiles WHERE user_id = p_target_user_id;
  RETURN jsonb_build_object('expense_count', v_expenses, 'audit_log_count', v_audit, 'balance_ledger_count', v_ledger, 'batch_count', v_batches,
    'account_audit_event_count', v_events, 'account_created_at', v_created, 'first_expense_at', v_first,
    'has_history', (v_expenses + v_audit + v_ledger + v_batches) > 0);
END $$;

-- Records the admin's explicit confirmation of an identity re-assignment. Old values are read from the database; the new values
-- are what the admin declared they are about to save.
CREATE OR REPLACE FUNCTION public.record_account_identity_change_confirmation_v1(
  p_organization_id uuid, p_target_user_id uuid, p_new_name text, p_new_email text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.profiles%ROWTYPE; v_summary jsonb; v_id uuid; v_uid uuid := auth.uid(); s jsonb;
BEGIN
  PERFORM public._uaa_assert_org_admin_of_target(p_organization_id, p_target_user_id);
  SELECT * INTO p FROM public.profiles WHERE user_id = p_target_user_id;
  v_summary := public.get_user_identity_history_summary_v1(p_organization_id, p_target_user_id);
  s := jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id,
                          'role', public._uaa_role_of(p_target_user_id, p_organization_id), 'organization_id', p_organization_id);
  v_id := public._uaa_emit(p_organization_id, p_target_user_id, 'account_identity_changed', 'name+email',
    jsonb_build_object('name', p.name, 'email', p.email),
    jsonb_build_object('name', left(p_new_name, 120), 'email', lower(left(p_new_email, 254))), s,
    jsonb_build_object('confirmed_by_admin', true, 'warning', 'name_and_email_changed_on_account_with_history',
                       'history', v_summary - 'account_created_at' - 'first_expense_at',
                       'account_created_at', v_summary -> 'account_created_at'));
  RETURN v_id;
END $$;

-- The identity timeline: oldest first, each row carrying the identity the account had AT THAT MOMENT (from the frozen snapshot).
CREATE OR REPLACE FUNCTION public.user_identity_timeline_v1(p_organization_id uuid, p_target_user_id uuid, p_limit int DEFAULT 500)
RETURNS TABLE (
  event_id uuid, occurred_at timestamptz, event_type text, summary text, actor_user_id uuid, actor_name text, actor_type text,
  source text, field_name text, old_value jsonb, new_value jsonb, identity_name text, identity_email text, request_id text, execution_context text
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT e.id, e.created_at, e.event_type,
    CASE e.event_type
      WHEN 'email_changed'               THEN 'Email changed: ' || COALESCE(e.old_value #>> '{}', '—') || ' → ' || COALESCE(e.new_value #>> '{}', '—')
      WHEN 'profile_updated'             THEN COALESCE(e.field_name, 'Profile') || ' changed: ' || COALESCE(e.old_value #>> '{}', '—') || ' → ' || COALESCE(e.new_value #>> '{}', '—')
      WHEN 'employee_id_changed'         THEN 'Employee ID changed: ' || COALESCE(e.old_value #>> '{}', '—') || ' → ' || COALESCE(e.new_value #>> '{}', '—')
      WHEN 'role_changed'                THEN 'Role changed: ' || COALESCE(e.old_value #>> '{}', '—') || ' → ' || COALESCE(e.new_value #>> '{}', '—')
      WHEN 'supervisor_changed'          THEN 'Supervisor changed: ' || COALESCE(e.metadata ->> 'old_label', '—') || ' → ' || COALESCE(e.metadata ->> 'new_label', '—')
      WHEN 'team_changed'                THEN 'Team: ' || COALESCE(e.metadata ->> 'change', 'changed') || ' ' || COALESCE(e.metadata ->> 'new_label', e.metadata ->> 'old_label', '')
      WHEN 'location_changed'            THEN 'Location: ' || COALESCE(e.metadata ->> 'change', 'changed') || ' ' || COALESCE(e.metadata ->> 'new_label', e.metadata ->> 'old_label', '')
      WHEN 'cashier_assignment_changed'  THEN 'Cashier assignment changed: ' || COALESCE(e.metadata ->> 'old_label', '—') || ' → ' || COALESCE(e.metadata ->> 'new_label', '—')
      WHEN 'user_deactivated'            THEN 'Deactivated'
      WHEN 'user_reactivated'            THEN 'Reactivated'
      WHEN 'user_banned'                 THEN 'Login suspended (auth ban)'
      WHEN 'user_unbanned'               THEN 'Login restored (auth unban)'
      WHEN 'password_changed'            THEN 'Password changed'
      WHEN 'admin_password_reset'        THEN 'Password reset by administrator'
      WHEN 'password_reset_requested'    THEN 'Password reset requested'
      WHEN 'password_reset_completed'    THEN 'Password reset completed'
      WHEN 'account_identity_changed'    THEN 'Name and login email changed together (confirmed): ' || COALESCE(e.old_value ->> 'name', '—') || ' / ' || COALESCE(e.old_value ->> 'email', '—')
                                                || ' → ' || COALESCE(e.new_value ->> 'name', '—') || ' / ' || COALESCE(e.new_value ->> 'email', '—')
      WHEN 'user_created'                THEN 'Account created'
      WHEN 'baseline_snapshot'           THEN 'Recorded state when audit history was enabled (earlier history is not available)'
      ELSE replace(e.event_type, '_', ' ') END,
    e.actor_user_id, e.actor_snapshot ->> 'name', e.actor_type, e.source, e.field_name, e.old_value, e.new_value,
    e.target_snapshot ->> 'name', e.target_snapshot ->> 'email', e.request_id, e.metadata ->> 'execution_context'
  FROM public.user_account_audit_events e
  WHERE e.target_user_id = p_target_user_id AND (p_organization_id IS NULL OR e.organization_id = p_organization_id)
  ORDER BY e.created_at ASC, e.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 2000)
$$;

REVOKE ALL ON FUNCTION public.register_my_account_audit_context_v1(text, text), public.get_user_identity_history_summary_v1(uuid, uuid),
  public.record_account_identity_change_confirmation_v1(uuid, uuid, text, text), public.user_identity_timeline_v1(uuid, uuid, int)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_my_account_audit_context_v1(text, text), public.get_user_identity_history_summary_v1(uuid, uuid),
  public.record_account_identity_change_confirmation_v1(uuid, uuid, text, text), public.user_identity_timeline_v1(uuid, uuid, int) TO authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. Backfill: hard evidence only. No actor is guessed; no historical identity is reconstructed from current values.
-- ---------------------------------------------------------------------------------------------------------------------------
-- (a) The pre-existing deactivate/reactivate log recorded its actor, so those rows are carried over (snapshot unavailable by design).
INSERT INTO public.user_account_audit_events
  (organization_id, target_user_id, actor_user_id, actor_type, event_type, source, request_id, batch_id, field_name, target_snapshot, actor_snapshot, metadata, created_at)
SELECT a.organization_id, a.target_user_id, a.actor_user_id, 'user', a.event_type, 'historical_backfill', 'backfill:' || a.id::text, 'backfill-account_audit_events',
       NULL, NULL, public._uaa_scrub(public._uaa_actor_snapshot(a.actor_user_id)),
       jsonb_build_object('evidence_source', 'account_audit_events', 'confidence', 'actor_recorded_at_the_time', 'snapshot_unavailable', true,
                          'reason', a.reason),
       a.created_at
FROM public.account_audit_events a
WHERE a.event_type IN ('user_deactivated', 'user_reactivated', 'auth_ban_failed', 'auth_unban_failed', 'auth_sync_recovered')
  AND NOT EXISTS (SELECT 1 FROM public.user_account_audit_events e WHERE e.request_id = 'backfill:' || a.id::text);

-- (b) One honest anchor per existing account: the state at the moment audit history was enabled.
INSERT INTO public.user_account_audit_events
  (organization_id, target_user_id, actor_user_id, actor_type, event_type, source, request_id, batch_id, target_snapshot, metadata)
SELECT COALESCE(p.organization_id, m.organization_id), p.user_id, NULL, 'migration', 'baseline_snapshot', 'migration',
       'baseline:20261031', 'baseline-20261031',
       jsonb_build_object('name', p.name, 'email', p.email, 'employee_id', p.employee_id, 'role', m.role::text,
                          'organization_id', COALESCE(p.organization_id, m.organization_id), 'profile_active', p.is_active, 'membership_active', m.is_active),
       jsonb_build_object('evidence_source', 'profiles+organization_memberships', 'confidence', 'state_at_migration_time',
                          'note', 'No earlier history is available for this account; who created or changed it before this point is unknown.')
FROM public.profiles p
LEFT JOIN public.organization_memberships m ON m.user_id = p.user_id
WHERE NOT EXISTS (SELECT 1 FROM public.user_account_audit_events e WHERE e.target_user_id = p.user_id AND e.event_type = 'baseline_snapshot');

COMMIT;
