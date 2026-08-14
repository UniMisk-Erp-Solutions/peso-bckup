-- =============================================================================
-- Tenant employee-ID login diagnostics — READ ONLY
--
-- Purpose: verify why employee ID 5003 on ml.pesowise.unimisk.com does or does
-- not reach get_employee_auth_email. Run the blocks in order in the Supabase SQL
-- editor and read the results; nothing here writes, creates, alters or drops.
--
-- SAFETY
--   * Every statement is a SELECT. There is no INSERT/UPDATE/DELETE/DDL.
--   * Block 5 is commented out because get_employee_auth_email is VOLATILE — it
--     writes a rate-limit row and returns the synthetic auth email. Only run it
--     deliberately, and do not paste its output into a ticket or a chat.
--   * These queries were NOT executed by the change that shipped this file.
--
-- Substitute the values below if you are diagnosing a different tenant/employee.
--   subdomain   : 'ml'
--   employee id : '5003'
-- =============================================================================


-- 1 ── Does the 'ml' subdomain resolve to an organization, and is it unique? ---
SELECT
  o.id                AS organization_id,
  o.name,
  o.slug,
  o.subdomain,
  count(*) OVER ()    AS rows_matching_subdomain
FROM public.organizations o
WHERE lower(trim(o.subdomain)) = 'ml';
-- Expect exactly 1 row. Zero rows ⇒ the Auth page reports "not configured"
-- (tenantResolutionStatus = 'not_found'), and employee-ID login can never engage.


-- 2 ── Is employee_id_login enabled for that organization? --------------------
SELECT
  o.id            AS organization_id,
  o.name,
  f.feature_key,
  f.enabled,
  CASE
    WHEN f.feature_key IS NULL THEN 'NO ROW → treated as disabled'
    WHEN f.enabled THEN 'enabled'
    ELSE 'explicitly disabled'
  END AS interpretation
FROM public.organizations o
LEFT JOIN public.organization_features f
  ON f.organization_id = o.id
 AND f.feature_key = 'employee_id_login'
WHERE lower(trim(o.subdomain)) = 'ml';
-- Expect enabled = true. A missing row or false ⇒ get_employee_auth_email
-- returns NULL for every employee ID, which the UI shows as an invalid ID.


-- 3 ── Does employee ID 5003 exist in that organization, and is it active? ----
SELECT
  p.user_id,
  p.employee_id,
  p.organization_id,
  p.is_active,
  (p.email IS NOT NULL AND length(trim(p.email)) > 0) AS has_auth_email,
  length(p.employee_id)                               AS employee_id_length
FROM public.profiles p
JOIN public.organizations o ON o.id = p.organization_id
WHERE lower(trim(o.subdomain)) = 'ml'
  AND lower(trim(p.employee_id)) = lower(trim('5003'));
-- Expect exactly 1 row with is_active = true and has_auth_email = true.
-- employee_id_length <> 4 would mean stored padding/whitespace differs from '5003'.
-- The RPC matches on lower(trim(employee_id)) — leading zeros are significant,
-- so '05003' and '5003' are different employees.


-- 4 ── Is the same employee ID duplicated inside the organization? -----------
SELECT
  p.organization_id,
  lower(trim(p.employee_id)) AS normalized_employee_id,
  count(*)                   AS occurrences,
  count(*) FILTER (WHERE COALESCE(p.is_active, true)) AS active_occurrences
FROM public.profiles p
JOIN public.organizations o ON o.id = p.organization_id
WHERE lower(trim(o.subdomain)) = 'ml'
  AND p.employee_id IS NOT NULL
  AND trim(p.employee_id) <> ''
GROUP BY p.organization_id, lower(trim(p.employee_id))
HAVING count(*) FILTER (WHERE COALESCE(p.is_active, true)) > 1
ORDER BY active_occurrences DESC, normalized_employee_id;
-- Expect zero rows. The RPC uses LIMIT 1, so a duplicate would resolve to an
-- arbitrary one of the matching accounts.


-- 5 ── Is the employee ID leaking across organizations? ----------------------
SELECT
  o.subdomain,
  o.name AS organization_name,
  count(*) AS profiles_with_this_employee_id
FROM public.profiles p
JOIN public.organizations o ON o.id = p.organization_id
WHERE lower(trim(p.employee_id)) = lower(trim('5003'))
GROUP BY o.subdomain, o.name
ORDER BY o.subdomain;
-- Informational: the RPC is organization-scoped, so rows for other orgs are
-- expected and harmless. Confirms no cross-tenant resolution is possible.


-- 6 ── Do the required RPCs exist, with the expected signatures? -------------
SELECT
  p.proname                                   AS function_name,
  pg_get_function_identity_arguments(p.oid)   AS arguments,
  pg_get_function_result(p.oid)               AS returns,
  p.provolatile                               AS volatility,   -- 'v' = VOLATILE
  p.prosecdef                                 AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_employee_auth_email',
    'get_organization_by_subdomain',
    'get_organization_feature_enabled',
    'get_tenant_sign_in_subdomain_for_email',
    'get_tenant_sign_in_subdomain_for_user',
    'email_can_sign_in_on_tenant'
  )
ORDER BY p.proname;
-- Expect get_employee_auth_email(p_organization_id uuid, p_employee_id text)
-- → text, volatility 'v', security_definer true.
-- A MISSING row means the migration has not been applied to this project.


-- 7 ── Can the anon role execute the pre-auth lookups? -----------------------
SELECT
  p.proname AS function_name,
  r.rolname AS grantee,
  has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) r
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_employee_auth_email',
    'get_organization_by_subdomain',
    'get_organization_feature_enabled'
  )
ORDER BY p.proname, r.rolname;
-- Expect can_execute = true for anon on all three — the sign-in page calls them
-- before any session exists.


-- 8 ── Is the rate limiter currently blocking this employee ID? --------------
-- get_employee_auth_email returns NULL (indistinguishable from "not found") once
-- an ID exceeds 8 lookups / 15 min, or the org exceeds 60 / 15 min.
SELECT
  a.lookup_key,
  count(*)        AS attempts_last_15_min,
  max(a.attempted_at) AS last_attempt,
  CASE WHEN count(*) >= 8 THEN 'RATE LIMITED' ELSE 'ok' END AS per_id_status
FROM public.employee_auth_lookup_attempts a
JOIN public.organizations o ON o.id = a.organization_id
WHERE lower(trim(o.subdomain)) = 'ml'
  AND a.attempted_at > now() - interval '15 minutes'
GROUP BY a.lookup_key
ORDER BY attempts_last_15_min DESC;

SELECT
  count(*) AS org_attempts_last_15_min,
  CASE WHEN count(*) >= 60 THEN 'ORG RATE LIMITED' ELSE 'ok' END AS per_org_status
FROM public.employee_auth_lookup_attempts a
JOIN public.organizations o ON o.id = a.organization_id
WHERE lower(trim(o.subdomain)) = 'ml'
  AND a.attempted_at > now() - interval '15 minutes';


-- 9 ── OPTIONAL — end-to-end RPC check.  ⚠ WRITES A RATE-LIMIT ROW ⚠ ---------
-- Uncomment only when blocks 1–8 look correct and you still need proof the RPC
-- resolves. It returns the synthetic auth email; treat that output as sensitive
-- and do not paste it into logs, tickets or chat.
--
-- SELECT public.get_employee_auth_email(
--   (SELECT o.id FROM public.organizations o WHERE lower(trim(o.subdomain)) = 'ml'),
--   '5003'
-- ) IS NOT NULL AS rpc_resolved_an_email;
--
-- Returning the boolean (not the email) keeps the address out of the result grid.
