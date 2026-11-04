-- DOC-158 acceptance harness. THROWAWAY database only (a disposable container; never Production).
-- Builds the minimum of the PesoWise schema that the audit migration touches, with realistic grants, plus a legacy account and a
-- legacy account_audit_events row that exist BEFORE the migration (to prove the backfill).
CREATE SCHEMA IF NOT EXISTS auth;
DROP TABLE IF EXISTS auth.users CASCADE;  -- the disposable image ships a different stub
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, encrypted_password text, banned_until timestamptz,
  raw_user_meta_data jsonb, last_sign_in_at timestamptz, updated_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
                  (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('admin','manager','employee','engineer','cashier','team_leader','executive');
CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE, name text, email text,
  balance numeric DEFAULT 0, reporting_engineer_id uuid, cashier_assigned_engineer_id uuid, assigned_cashier_id uuid,
  cashier_assigned_location_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), is_active boolean DEFAULT true,
  organization_id uuid, is_master_admin boolean DEFAULT false, employee_id text, preferred_language text, deactivated_at timestamptz,
  notification_settings jsonb);
CREATE TABLE public.organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, role public.app_role NOT NULL, invited_by uuid, joined_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true, is_accountant_cashier boolean DEFAULT false, UNIQUE (user_id));
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, role public.app_role, created_at timestamptz DEFAULT now());
CREATE TABLE public.master_admin_memberships (user_id uuid);
CREATE TABLE public.locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, organization_id uuid);
CREATE TABLE public.teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, name text);
CREATE TABLE public.team_members (team_id uuid, user_id uuid, organization_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.engineer_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), engineer_id uuid, location_id uuid, created_at timestamptz DEFAULT now(), organization_id uuid);
CREATE TABLE public.account_audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, target_user_id uuid, actor_user_id uuid,
  event_type text, reason text, details jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE public.expenses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid, created_by uuid, submitted_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.balance_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.expense_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);

CREATE FUNCTION public.is_org_admin(p_org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_memberships om WHERE om.user_id = auth.uid() AND om.organization_id = p_org_id AND om.role = 'admin' AND om.is_active) $$;
CREATE FUNCTION public.is_master_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND is_master_admin = true)
      OR EXISTS (SELECT 1 FROM public.master_admin_memberships WHERE user_id = auth.uid()) $$;

-- Mimic Production: a new auth user gets a profile (name / organization from metadata) via a SECURITY DEFINER trigger.
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (user_id, name, email, organization_id)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'name', NEW.email, NULLIF(NEW.raw_user_meta_data ->> 'organization_id', '')::uuid);
  -- Production's handle_new_user also creates the membership when the metadata names an organization.
  IF (NEW.raw_user_meta_data ->> 'auto_membership') = 'true' THEN
    INSERT INTO public.organization_memberships (organization_id, user_id, role)
    VALUES ((NEW.raw_user_meta_data ->> 'organization_id')::uuid, NEW.id, 'employee');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Mimic trg_sync_user_role_from_membership (derived legacy rows).
CREATE FUNCTION public.sync_user_role_from_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.user_roles WHERE user_id = NEW.user_id;
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, NEW.role);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sync_user_role_from_membership AFTER INSERT OR UPDATE ON public.organization_memberships FOR EACH ROW EXECUTE FUNCTION public.sync_user_role_from_membership();

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT SELECT ON auth.users TO authenticated;
GRANT ALL ON auth.users TO service_role;  -- stands in for GoTrue's own writes in these tests

-- helpers
CREATE TABLE public.zz_results (n serial, name text, ok boolean);
GRANT ALL ON public.zz_results TO PUBLIC;
CREATE FUNCTION public.zz_check(p_name text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.zz_results (name, ok) VALUES (p_name, COALESCE(p_ok, false));
      RAISE NOTICE '% %', CASE WHEN COALESCE(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, p_name; END $$;
CREATE FUNCTION public.zz_as(p_uid uuid, p_role text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', p_role, true);
END $$;
CREATE FUNCTION public.zz_clear() RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true); PERFORM set_config('request.jwt.claim.role', '', true); END $$;
CREATE TABLE public.zz_ctx (k text PRIMARY KEY, v text);
GRANT ALL ON public.zz_ctx TO PUBLIC;

-- LEGACY data that exists before the migration: an org, an admin, a legacy employee and one old deactivate record.
DO $$
DECLARE o uuid := gen_random_uuid(); a uuid := gen_random_uuid(); l uuid := gen_random_uuid();
BEGIN
  INSERT INTO organizations (id, name) VALUES (o, 'Legacy Org');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (a, 'legacy-admin@example.test', jsonb_build_object('name', 'Legacy Admin', 'organization_id', o));
  INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (o, a, 'admin');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (l, 'legacy-emp@example.test', jsonb_build_object('name', 'Legacy Employee', 'organization_id', o));
  INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (o, l, 'employee');
  INSERT INTO account_audit_events (organization_id, target_user_id, actor_user_id, event_type, reason, created_at)
  VALUES (o, l, a, 'user_deactivated', 'legacy reason', now() - interval '30 days');
  INSERT INTO zz_ctx VALUES ('legacy_org', o::text), ('legacy_admin', a::text), ('legacy_emp', l::text);
END $$;
