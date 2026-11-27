-- READ-ONLY audit of what the ANONYMOUS role can reach (DOC-167).
-- Run after the hardening migration, on backup AND production. Expected results are in the comments.

-- 1. Functions anon can EXECUTE.  Expected: exactly 4 rows
--    get_organization_by_subdomain, get_organization_feature_enabled,
--    get_employee_auth_email, email_can_sign_in_on_tenant
SELECT p.oid::regprocedure AS anon_callable_function
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY 1;

-- 2. Table privileges held by anon.  Expected: only contact_leads / INSERT
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon' AND table_schema = 'public'
ORDER BY 1, 2;

-- 3. Policies that grant everything to everyone (qual = true).  Expected: review every row;
--    none may apply to roles {public} or {anon} on a business table.
SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (qual = 'true' OR with_check = 'true')
ORDER BY tablename, policyname;

-- 4. Public tables with RLS DISABLED.  Expected: none that hold business data
SELECT c.relname AS table_without_rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
ORDER BY 1;

-- 5. SECURITY DEFINER functions authenticated users can call - review each for an
--    auth.uid() / role / master-admin check (audit item, not auto-fixed).
SELECT p.oid::regprocedure AS definer_function
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND p.prosrc !~* '(auth\.uid\(\)|is_master_admin|has_role|auth\.jwt)'
ORDER BY 1;

-- 6. Anonymous statement timeout.  Expected: statement_timeout=3s
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'anon';
