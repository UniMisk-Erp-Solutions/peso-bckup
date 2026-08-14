-- 290529_1202_verify_after_safe_restore.sql
-- Read-only checks after 1200 + 1201. Safe to re-run anytime.

-- 1) URLs still on old project (expect 0)
SELECT COUNT(*) AS attachments_still_on_old_project
FROM public.attachments
WHERE file_url LIKE '%briypgrgqagbexudarba%';

SELECT COUNT(*) AS logos_still_on_old_project
FROM public.organizations
WHERE logo_url LIKE '%briypgrgqagbexudarba%';

-- 2) anon table grants (expect only contact_leads INSERT, if any)
SELECT grantee, privilege_type, table_name
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
ORDER BY table_name, privilege_type;

-- 3) public tables: RLS + policy count (0 = no access except service_role)
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  COUNT(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
HAVING COUNT(p.polname) = 0
ORDER BY table_name;

-- 4) storage.objects policies (expect authenticated-only; no {public} role)
SELECT
  policyname,
  roles,
  cmd AS operation
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
ORDER BY policyname;

-- 5) Quick grant smoke test labels (no failure if empty)
SELECT
  has_table_privilege('authenticated', 'public.expenses', 'SELECT') AS auth_can_select_expenses,
  has_table_privilege('anon', 'public.expenses', 'SELECT') AS anon_can_select_expenses,
  has_table_privilege('anon', 'public.contact_leads', 'INSERT') AS anon_can_insert_contact_leads;
