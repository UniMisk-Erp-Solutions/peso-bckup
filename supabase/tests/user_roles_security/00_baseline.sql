-- Privilege-escalation regression harness. THROWAWAY database only.
-- Re-creates, VERBATIM, the Production policies/functions that were vulnerable on 2026-10-24 (user_roles, profiles, organization_memberships,
-- master_admin_memberships), with Production's grants (anon + authenticated hold full table privileges; RLS is the only gate).
DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

DROP TABLE IF EXISTS auth.users CASCADE;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, encrypted_password text, banned_until timestamptz, raw_user_meta_data jsonb);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''), (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT ALL ON auth.users TO service_role; GRANT SELECT ON auth.users TO authenticated;

CREATE TYPE public.app_role AS ENUM ('admin','engineer','employee','cashier','team_leader','executive');
CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE, name text, email text, balance numeric DEFAULT 0,
  reporting_engineer_id uuid, cashier_assigned_engineer_id uuid, assigned_cashier_id uuid, cashier_assigned_location_id uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), is_active boolean DEFAULT true, organization_id uuid,
  is_master_admin boolean DEFAULT false, employee_id text, preferred_language text, deactivated_at timestamptz, notification_settings jsonb);
CREATE TABLE public.organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE, role public.app_role NOT NULL, invited_by uuid,
  joined_at timestamptz DEFAULT now(), is_active boolean DEFAULT true, is_accountant_cashier boolean DEFAULT false);
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, role public.app_role, created_at timestamptz DEFAULT now(), UNIQUE (user_id, role));
CREATE TABLE public.master_admin_memberships (user_id uuid, is_active boolean DEFAULT true);
CREATE TABLE public.team_members (team_id uuid, user_id uuid, organization_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.engineer_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), engineer_id uuid, location_id uuid, created_at timestamptz DEFAULT now(), organization_id uuid);
CREATE TABLE public.teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, name text);
CREATE TABLE public.locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, organization_id uuid);

-- helpers, verbatim from Production
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE FUNCTION public.is_master_admin() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND is_master_admin = true)
          OR EXISTS (SELECT 1 FROM public.master_admin_memberships WHERE user_id = auth.uid() AND is_active = true); END; $$;
CREATE FUNCTION public.is_org_admin(p_org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_memberships om WHERE om.user_id = auth.uid() AND om.organization_id = p_org_id AND om.role = 'admin' AND om.is_active = true) $$;
CREATE FUNCTION public.has_org_role(_role public.app_role) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN COALESCE((SELECT EXISTS (SELECT 1 FROM public.organization_memberships WHERE user_id = auth.uid() AND role = _role AND is_active = true)), false); END; $$;
CREATE FUNCTION public.get_user_organization_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT organization_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1 $$;
CREATE FUNCTION public.admin_reset_user_password(target_user_id uuid, new_password text, admin_password text) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE admin_user_id uuid; target_user_email text;
BEGIN admin_user_id := auth.uid();
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = admin_user_id AND role = 'admin') THEN RETURN json_build_object('success', false, 'error', 'Only administrators can reset passwords'); END IF;
  SELECT email INTO target_user_email FROM public.profiles WHERE user_id = target_user_id;
  RETURN json_build_object('success', true, 'message', 'Password reset initiated', 'target_email', target_user_email); END; $$;

-- membership -> user_roles sync, verbatim (SECURITY DEFINER, owner bypasses RLS)
CREATE FUNCTION public.sync_user_role_from_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM public.user_roles WHERE user_id = OLD.user_id AND role = OLD.role; RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role THEN DELETE FROM public.user_roles WHERE user_id = NEW.user_id AND role = OLD.role; END IF;
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, NEW.role) ON CONFLICT (user_id, role) DO NOTHING; RETURN NEW; END; $$;
CREATE TRIGGER trg_sync_user_role_from_membership AFTER INSERT OR UPDATE OR DELETE ON public.organization_memberships FOR EACH ROW EXECUTE FUNCTION public.sync_user_role_from_membership();

-- RLS: policies VERBATIM from Production (read 2026-10-24)
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY; ALTER TABLE public.user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage roles" ON public.user_roles USING (has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can insert user_roles in their org for restore" ON public.user_roles FOR INSERT WITH CHECK (user_id IN (SELECT om.user_id FROM organization_memberships om WHERE om.organization_id IN (SELECT o2.organization_id FROM organization_memberships o2 WHERE o2.user_id = auth.uid() AND o2.role = 'admin'::app_role AND o2.is_active = true)));
CREATE POLICY "Users can insert their own roles" ON public.user_roles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins and cashiers can view all roles" ON public.user_roles FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'cashier'::app_role));
CREATE POLICY "Cashiers can view admin roles" ON public.user_roles FOR SELECT USING (has_role(auth.uid(), 'cashier'::app_role) AND role = 'admin'::app_role);
CREATE POLICY "Engineers and employees can view cashier and admin roles" ON public.user_roles FOR SELECT USING ((has_role(auth.uid(), 'engineer'::app_role) OR has_role(auth.uid(), 'employee'::app_role)) AND role = ANY (ARRAY['cashier'::app_role, 'admin'::app_role]));
CREATE POLICY "Users can view their own roles" ON public.user_roles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can update user_roles in their org for restore" ON public.user_roles FOR UPDATE
  USING (user_id IN (SELECT om.user_id FROM organization_memberships om WHERE om.organization_id IN (SELECT o2.organization_id FROM organization_memberships o2 WHERE o2.user_id = auth.uid() AND o2.role = 'admin'::app_role AND o2.is_active = true)))
  WITH CHECK (user_id IN (SELECT om.user_id FROM organization_memberships om WHERE om.organization_id IN (SELECT o2.organization_id FROM organization_memberships o2 WHERE o2.user_id = auth.uid() AND o2.role = 'admin'::app_role AND o2.is_active = true)));
CREATE POLICY "Users can update their own roles" ON public.user_roles FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id AND (organization_id = get_user_organization_id() OR is_master_admin())) WITH CHECK (auth.uid() = user_id AND (organization_id = get_user_organization_id() OR is_master_admin()));
CREATE POLICY "Admins can update any profile" ON public.profiles FOR UPDATE USING (EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = auth.uid() AND om.organization_id = profiles.organization_id AND om.role = 'admin'::app_role AND om.is_active = true))
  WITH CHECK (organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = auth.uid() AND om.organization_id = profiles.organization_id AND om.role = 'admin'::app_role AND om.is_active = true));
-- simplified stand-in for "Cashiers can update managed profiles" (the real one adds assignment checks); enough to prove the flag guard
CREATE POLICY "Cashiers can update managed profiles" ON public.profiles FOR UPDATE USING (EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = auth.uid() AND om.organization_id = profiles.organization_id AND om.role = 'cashier'::app_role AND om.is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = auth.uid() AND om.organization_id = profiles.organization_id AND om.role = 'cashier'::app_role AND om.is_active = true));
CREATE POLICY "Admins can insert profiles" ON public.profiles FOR INSERT WITH CHECK (is_master_admin() OR (organization_id = get_user_organization_id() AND has_org_role('admin'::app_role)));
CREATE POLICY "profiles select (stand-in)" ON public.profiles FOR SELECT USING (organization_id = get_user_organization_id() OR is_master_admin());

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "organizations select (stand-in)" ON public.organizations FOR SELECT USING (id = get_user_organization_id() OR is_master_admin());

ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage memberships in their organization" ON public.organization_memberships USING (organization_id = get_user_organization_id() AND has_org_role('admin'::app_role)) WITH CHECK (organization_id = get_user_organization_id() AND has_org_role('admin'::app_role));
CREATE POLICY "Users can view memberships in their organization" ON public.organization_memberships FOR SELECT USING (organization_id = get_user_organization_id());

ALTER TABLE public.master_admin_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Master admins can manage master admin memberships" ON public.master_admin_memberships USING (is_master_admin()) WITH CHECK (is_master_admin());

-- helpers for the tests
CREATE TABLE public.zz_results (n serial, name text, ok boolean); GRANT ALL ON public.zz_results TO PUBLIC;
CREATE TABLE public.zz_ids (k text PRIMARY KEY, v uuid); GRANT ALL ON public.zz_ids TO PUBLIC;
CREATE FUNCTION public.zz_check(p_name text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.zz_results (name, ok) VALUES (p_name, COALESCE(p_ok, false)); RAISE NOTICE '% %', CASE WHEN COALESCE(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, p_name; END $$;
CREATE FUNCTION public.zz_id(k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM public.zz_ids WHERE k = $1 $$;
-- Runs ONE statement as a real role with a real JWT subject, returns 'ok' (rows changed), 'noop' (0 rows) or 'blocked', and rolls it back.
CREATE FUNCTION public.zz_try(p_sql text, p_uid uuid, p_role text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n bigint; r text := 'blocked';
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', p_role, true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; RESET ROLE;
    r := CASE WHEN n > 0 THEN 'ok' ELSE 'noop' END;
    RAISE EXCEPTION 'rollback-marker';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'rollback-marker' THEN r := 'blocked'; END IF; END;
  RETURN r;
END $$;

-- synthetic population (no real data)
DO $$
DECLARE oa uuid := gen_random_uuid(); ob uuid := gen_random_uuid(); u record; vid uuid;
BEGIN
  INSERT INTO organizations VALUES (oa, 'Org A'), (ob, 'Org B');
  INSERT INTO zz_ids VALUES ('orgA', oa), ('orgB', ob);
  FOR u IN SELECT * FROM (VALUES ('E1','A','employee'),('E2','A','employee'),('AA','A','admin'),('AB','B','admin'),('EB','B','employee'),('CA','A','cashier'),('MA','A','employee')) t(k,o,r) LOOP
    vid := gen_random_uuid();
    INSERT INTO auth.users (id, email) VALUES (vid, lower(u.k) || '@example.test');
    INSERT INTO profiles (user_id, name, email, organization_id, balance) VALUES (vid, u.k, lower(u.k) || '@example.test', CASE WHEN u.o = 'A' THEN oa ELSE ob END, 100);
    INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (CASE WHEN u.o = 'A' THEN oa ELSE ob END, vid, u.r::app_role);
    INSERT INTO zz_ids VALUES (u.k, vid);
  END LOOP;
  UPDATE profiles SET is_master_admin = true WHERE user_id = zz_id('MA');
END $$;
