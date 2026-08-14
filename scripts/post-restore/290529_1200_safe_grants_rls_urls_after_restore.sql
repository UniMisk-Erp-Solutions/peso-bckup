-- 290529_1200_safe_grants_rls_urls_after_restore.sql
-- =============================================================================
-- SAFE post-restore hardening (replaces unsafe GRANT ALL in manual-section-1)
-- Run in Supabase SQL Editor on project kqlqirdneocivumdjtvx.
--
-- What this does:
--   1. Revokes broad table/routine/sequence access from anon + authenticated
--   2. Re-grants least privilege (authenticated: CRUD + EXECUTE; anon: almost none)
--   3. Keeps service_role + postgres with full access
--   4. Enables RLS on every public table (deny-by-default if no policy)
--   5. Rewrites old project URLs in attachments + organization logos
--
-- Storage policies are NOT in this file (storage.objects is owned by
-- supabase_storage_admin). Run second:
--   npm run post-restore:storage-policies  (Direct DB connection — not SQL Editor)
--
-- RLS policy bodies: your backup should already include org-scoped policies from
-- production. After this script, run the verification block at the bottom.
-- If any critical table has 0 policies, also run:
--   master_migration/12_fix_all_rls_policies_comprehensive.sql
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1 — REVOKE dangerous privileges (undo unsafe Section 1 grants)
-- =============================================================================

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- (Do not REVOKE/GRANT on storage.* here — table owner is supabase_storage_admin.)

-- Reset default privileges so future objects are not auto-opened to anon
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON ROUTINES TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO postgres, service_role;

-- =============================================================================
-- PART 2 — Safe schema + table grants
-- =============================================================================

GRANT USAGE ON SCHEMA public TO postgres, service_role, authenticated, anon;

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;

-- authenticated: table CRUD only (RLS enforces rows)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO authenticated;

-- anon: no public table access by default (exceptions in Part 4)
-- (no GRANT on tables here)

-- Future tables in public (same least-privilege pattern)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON ROUTINES TO authenticated;

-- =============================================================================
-- PART 3 — Narrow anon exceptions (pre-login / marketing only)
-- =============================================================================

-- Contact form: anon may INSERT one row; SELECT blocked unless is_master_admin() policy
GRANT INSERT ON TABLE public.contact_leads TO anon;

-- Pre-auth tenant lookup RPCs (EXECUTE only — no table grants)
DO $grant_anon_rpc$
DECLARE
  fn_sig text;
  fn_oid regprocedure;
BEGIN
  FOREACH fn_sig IN ARRAY ARRAY[
    'public.get_organization_by_subdomain(text)',
    'public.get_organization_feature_enabled(uuid,text)',
    'public.get_employee_auth_email(uuid,text)',
    'public.email_can_sign_in_on_tenant(text,uuid)',
    'public.get_tenant_sign_in_subdomain_for_email(text)',
    'public.get_tenant_sign_in_subdomain_for_user(uuid)'
  ]
  LOOP
    fn_oid := to_regprocedure(fn_sig);
    IF fn_oid IS NULL THEN
      RAISE NOTICE 'Skipping missing function: %', fn_sig;
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', fn_oid);
    END IF;
  END LOOP;
END;
$grant_anon_rpc$;

-- Dev-only helper (omit in strict prod by commenting next block if undesired)
DO $grant_dev_login$
BEGIN
  IF to_regprocedure('public.list_organizations_for_dev_login()') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.list_organizations_for_dev_login() TO anon, authenticated, service_role';
  END IF;
END;
$grant_dev_login$;

-- strategies: authenticated read only (remove anon table grant from older migration)
REVOKE ALL ON TABLE public.strategies FROM anon;
GRANT SELECT ON TABLE public.strategies TO authenticated;

-- =============================================================================
-- PART 5 — Enable RLS on every public table
-- =============================================================================

DO $enable_rls$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    RAISE NOTICE 'Enabled RLS on public.%', r.table_name;
  END LOOP;
END;
$enable_rls$;

-- Force RLS for table owners too (defense in depth)
DO $force_rls$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
  END LOOP;
END;
$force_rls$;

-- =============================================================================
-- PART 6 — Rewrite attachment/logo URLs to new project (idempotent)
-- =============================================================================

UPDATE public.attachments
SET file_url = replace(file_url, 'briypgrgqagbexudarba', 'kqlqirdneocivumdjtvx')
WHERE file_url LIKE '%briypgrgqagbexudarba%';

UPDATE public.organizations
SET logo_url = replace(logo_url, 'briypgrgqagbexudarba', 'kqlqirdneocivumdjtvx')
WHERE logo_url IS NOT NULL
  AND logo_url LIKE '%briypgrgqagbexudarba%';

COMMIT;

-- =============================================================================
-- Done — everything above is committed. Optional checks: run
--   290529_1202_verify_after_safe_restore.sql
-- or the SELECTs in that file below (fixed column names for pg_policies).
-- =============================================================================
