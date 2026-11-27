-- =============================================================================
-- Security hardening v1 (DOC-167) - closes the findings of the 2026-11-26
-- black-box penetration test (F1-F13).
--
-- Principles
--   * Anonymous callers get the MINIMUM: only the pre-login RPCs the sign-in
--     page truly needs, and INSERT on contact_leads. Nothing else.
--   * Never WIDEN access: existing EXECUTE grants for authenticated /
--     service_role are preserved exactly as they are today.
--   * Idempotent: safe to run more than once.
--
-- RUN ORDER (important): deploy the two edge functions (admin-create-user,
-- bulk-users-import) FIRST - they now stamp app_metadata.pw_provisioned - and
-- only then run this migration. See Documentations MD/security-hardening-pentest-2026-11.md
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Rate-limit helper (used by anonymous pre-login RPCs)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rpc_rate_limits (
  id           bigserial PRIMARY KEY,
  bucket       text        NOT NULL,
  rate_key     text        NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rpc_rate_limits_bucket_key_time_idx
  ON public.rpc_rate_limits (bucket, rate_key, attempted_at DESC);

ALTER TABLE public.rpc_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rpc_rate_limits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.rpc_rate_limits_id_seq FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.rpc_rate_limits IS
  'Attempt log for anonymous pre-login RPCs. No client policies; written only by SECURITY DEFINER helpers.';

CREATE OR REPLACE FUNCTION public._rpc_rate_limit_ok(
  p_bucket text,
  p_key    text,
  p_max    integer,
  p_window interval
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*)::integer INTO v_count
  FROM public.rpc_rate_limits r
  WHERE r.bucket = p_bucket
    AND r.rate_key = p_key
    AND r.attempted_at > now() - p_window;

  IF v_count >= p_max THEN
    RETURN false;
  END IF;

  INSERT INTO public.rpc_rate_limits (bucket, rate_key) VALUES (p_bucket, p_key);

  -- Opportunistic cleanup (~1% of calls) keeps the table small without a cron job.
  IF random() < 0.01 THEN
    DELETE FROM public.rpc_rate_limits WHERE attempted_at < now() - interval '2 days';
  END IF;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._rpc_rate_limit_ok(text, text, integer, interval)
  FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. F1 - developer tenant list must not be callable from the internet
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.list_organizations_for_dev_login()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.list_organizations_for_dev_login()
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.list_organizations_for_dev_login() TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. F4 - member counts: master admin only (was SECURITY DEFINER with no check)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_organization_member_counts(org_ids uuid[] DEFAULT NULL)
RETURNS TABLE (organization_id uuid, member_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_master_admin() THEN
    RAISE EXCEPTION 'Only master admins can view member counts'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT om.organization_id, COUNT(*)::bigint
  FROM public.organization_memberships om
  WHERE om.is_active = true
    AND (org_ids IS NULL OR om.organization_id = ANY (org_ids))
  GROUP BY om.organization_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_organization_member_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_organization_member_counts(uuid[]) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. F3 - stop anonymous e-mail -> tenant mapping
--    * email lookup: only the signed-in user may resolve THEIR OWN e-mail
--    * user lookup : only the signed-in user may resolve THEIR OWN id
--    * email_can_sign_in_on_tenant stays anonymous (sign-in gate) but is
--      rate-limited per e-mail and only answers true/false for ONE given org.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_tenant_sign_in_subdomain_for_email(p_email text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result text;
BEGIN
  IF auth.uid() IS NULL
     OR lower(trim(coalesce(auth.jwt() ->> 'email', ''))) <> lower(trim(coalesce(p_email, ''))) THEN
    RETURN NULL;
  END IF;

  SELECT x.subdomain INTO v_result
  FROM (
    SELECT o.subdomain, 1 AS priority
    FROM public.profiles p
    INNER JOIN public.organizations o ON o.id = p.organization_id
    WHERE p.user_id = auth.uid()
      AND o.subdomain IS NOT NULL AND trim(o.subdomain) <> ''
    UNION ALL
    SELECT o.subdomain, 2 AS priority
    FROM public.organization_memberships om
    INNER JOIN public.organizations o ON o.id = om.organization_id
    WHERE om.user_id = auth.uid()
      AND COALESCE(om.is_active, true) = true
      AND o.subdomain IS NOT NULL AND trim(o.subdomain) <> ''
  ) x
  ORDER BY x.priority
  LIMIT 1;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_sign_in_subdomain_for_user(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RETURN NULL;
  END IF;

  SELECT x.subdomain INTO v_result
  FROM (
    SELECT o.subdomain, 1 AS priority
    FROM public.profiles p
    INNER JOIN public.organizations o ON o.id = p.organization_id
    WHERE p.user_id = p_user_id
      AND o.subdomain IS NOT NULL AND trim(o.subdomain) <> ''
    UNION ALL
    SELECT o.subdomain, 2 AS priority
    FROM public.organization_memberships om
    INNER JOIN public.organizations o ON o.id = om.organization_id
    WHERE om.user_id = p_user_id
      AND COALESCE(om.is_active, true) = true
      AND o.subdomain IS NOT NULL AND trim(o.subdomain) <> ''
  ) x
  ORDER BY x.priority
  LIMIT 1;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_tenant_sign_in_subdomain_for_email(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_tenant_sign_in_subdomain_for_user(uuid)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_sign_in_subdomain_for_email(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tenant_sign_in_subdomain_for_user(uuid)  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.email_can_sign_in_on_tenant(
  p_email text,
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_email IS NULL OR p_organization_id IS NULL OR trim(p_email) = '' THEN
    RETURN false;
  END IF;

  -- 20 checks / 15 min per e-mail: plenty for real logins, useless for probing.
  IF NOT public._rpc_rate_limit_ok(
       'email_can_sign_in_on_tenant', lower(trim(p_email)), 20, interval '15 minutes') THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.profiles p
    INNER JOIN public.organization_memberships om
      ON om.user_id = p.user_id
     AND om.organization_id = p_organization_id
     AND COALESCE(om.is_active, true) = true
    WHERE lower(trim(p.email)) = lower(trim(p_email))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.email_can_sign_in_on_tenant(text, uuid) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. F5 - organization_transaction_sequences: remove the open policy
--    (the old policy was FOR ALL USING (true) with no role => anon could read
--    AND any logged-in user could rewrite another tenant's counter).
--    Writes happen only inside SECURITY DEFINER trigger functions (table owner,
--    bypasses RLS), so no client write policy is needed.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.organization_transaction_sequences') IS NULL THEN
    RETURN;
  END IF;

  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'organization_transaction_sequences'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.organization_transaction_sequences', pol.policyname);
  END LOOP;

  ALTER TABLE public.organization_transaction_sequences ENABLE ROW LEVEL SECURITY;

  CREATE POLICY seq_select_own_org_or_master
    ON public.organization_transaction_sequences
    FOR SELECT TO authenticated
    USING (
      public.is_master_admin()
      OR EXISTS (
        SELECT 1 FROM public.organization_memberships om
        WHERE om.user_id = auth.uid()
          AND om.organization_id = organization_transaction_sequences.organization_id
          AND om.is_active = true
      )
    );

  REVOKE ALL ON TABLE public.organization_transaction_sequences FROM PUBLIC, anon;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.organization_transaction_sequences FROM authenticated;
  GRANT SELECT ON TABLE public.organization_transaction_sequences TO authenticated;
  GRANT ALL ON TABLE public.organization_transaction_sequences TO service_role;
END $$;

-- Any logged-in user could previously burn another organization's counter by
-- calling this RPC directly; the trigger runs it as the function owner anyway.
DO $$
BEGIN
  IF to_regprocedure('public.generate_transaction_number(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.generate_transaction_number(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.generate_transaction_number(uuid) TO service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. F7 - signup trigger: no more default-organization fallback, and the
--    organization in client-editable user_metadata is trusted ONLY when the
--    user was created by our own service-role edge functions, which stamp
--    app_metadata.pw_provisioned = true (app_metadata cannot be set by a
--    self-signup request). Anyone else gets an inert auth user with NO profile
--    and NO membership - so no org access and no schema-leaking 23502 error.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF COALESCE(NEW.raw_app_meta_data ->> 'pw_provisioned', '') <> 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.email IS NULL OR trim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_org := (NEW.raw_user_meta_data ->> 'organization_id')::uuid;
  EXCEPTION WHEN others THEN
    v_org := NULL;
  END;

  IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_org) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.profiles (user_id, name, email, organization_id, is_active)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(trim(NEW.raw_user_meta_data ->> 'name'), ''), 'New User'),
    NEW.email,
    v_org,
    true
  )
  ON CONFLICT (user_id) DO UPDATE SET
    name = COALESCE(EXCLUDED.name, public.profiles.name),
    email = COALESCE(EXCLUDED.email, public.profiles.email),
    organization_id = COALESCE(EXCLUDED.organization_id, public.profiles.organization_id),
    is_active = true;

  INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
  VALUES (v_org, NEW.id, 'employee', true)
  ON CONFLICT (organization_id, user_id) DO UPDATE SET is_active = true;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. F6/F11/F12 + least privilege for the anonymous role
--    a) EXECUTE: snapshot who may call each public function today, remove the
--       implicit PUBLIC/anon grant, re-grant exactly the same set to
--       authenticated / service_role, then give anon the pre-login allow-list.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r        record;
  rl       text;
  keep     text[];
  fn_sig   text;
  fn_oid   regprocedure;
BEGIN
  FOR r IN
    SELECT p.oid AS oid, p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    -- Remember which internal/app roles may run it TODAY (often only via PUBLIC),
    -- so removing PUBLIC never takes access away from them.
    keep := ARRAY[]::text[];
    FOREACH rl IN ARRAY ARRAY[
      'authenticated', 'service_role', 'postgres', 'supabase_auth_admin',
      'supabase_storage_admin', 'supabase_functions_admin', 'dashboard_user'
    ]
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rl)
         AND has_function_privilege(rl, r.oid, 'EXECUTE') THEN
        keep := keep || rl;
      END IF;
    END LOOP;

    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.fn);
    FOREACH rl IN ARRAY keep LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', r.fn, rl);
    END LOOP;
  END LOOP;

  -- Pre-login allow-list (the ONLY functions anonymous callers may run).
  FOREACH fn_sig IN ARRAY ARRAY[
    'public.get_organization_by_subdomain(text)',
    'public.get_organization_feature_enabled(uuid,text)',
    'public.get_employee_auth_email(uuid,text)',
    'public.email_can_sign_in_on_tenant(text,uuid)'
  ]
  LOOP
    fn_oid := to_regprocedure(fn_sig);
    IF fn_oid IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', fn_oid);
    END IF;
  END LOOP;
END $$;

-- b) Tables: anonymous role keeps ONLY "INSERT into contact_leads" (public form).
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

DO $$
BEGIN
  IF to_regclass('public.contact_leads') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.contact_leads TO anon;
  END IF;
END $$;

-- c) Secure by default for FUTURE objects: new functions/tables are not
--    reachable by anon unless a migration grants it explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

DO $$
BEGIN
  BEGIN
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'supabase_admin default privileges not changed (%): fine on non-Supabase hosts', SQLERRM;
  END;
END $$;

-- -----------------------------------------------------------------------------
-- 8. F10 - anonymous queries may not hold a connection for long
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    ALTER ROLE anon SET statement_timeout = '3s';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ALTER ROLE anon SET statement_timeout failed (%): set it as the DB owner instead', SQLERRM;
  END;
END $$;

COMMIT;

-- Make PostgREST pick up the new privileges immediately.
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
