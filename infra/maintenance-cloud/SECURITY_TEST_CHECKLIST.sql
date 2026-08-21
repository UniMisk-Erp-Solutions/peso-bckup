-- ============================================================================
-- CLOUD MAINTENANCE PROJECT ONLY.
-- DO NOT RUN AGAINST SELF-HOSTED PESOWISE SUPABASE.
--
-- Read-only-safe security checklist for the Cloud maintenance control plane.
-- Every mutating check runs inside BEGIN...ROLLBACK so nothing here can
-- permanently change data — this file proves RLS/grants, it does not exercise
-- real maintenance toggles. Run after applying
-- migrations/001_create_maintenance_control_plane.sql.
--
-- Replace the placeholder UUIDs below with real values from YOUR Cloud
-- project before running (see infra/maintenance-cloud/README.md for how to
-- create test admin users).
-- ============================================================================

-- \set preview_admin_uuid   '00000000-0000-0000-0000-000000000001'  -- can_manage_preview=true, can_manage_production=false
-- \set production_admin_uuid '00000000-0000-0000-0000-000000000002' -- can_manage_production=true
-- \set inactive_admin_uuid  '00000000-0000-0000-0000-000000000003' -- is_active=false
-- \set non_admin_uuid       '00000000-0000-0000-0000-000000000004' -- signed in, no maintenance_admins row

begin;
set transaction read only;

\echo '=== 1. Schema exists ==='
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('maintenance_status', 'maintenance_admins')
order by table_name;
-- EXPECT: both rows present

\echo '=== 2. Exactly two bootstrap rows, both NORMAL ==='
select environment, force_maintenance, starts_at, ends_at from public.maintenance_status order by environment;
-- EXPECT: preview | f | null | null
--         production | f | null | null

\echo '=== 3. RLS is enabled on both tables ==='
select relname, relrowsecurity from pg_class
where relname in ('maintenance_status', 'maintenance_admins') and relnamespace = 'public'::regnamespace;
-- EXPECT: both relrowsecurity = t

\echo '=== 4. Grants on maintenance_status — anon SELECT only ==='
select grantee, privilege_type, column_name
from information_schema.role_column_grants
where table_name = 'maintenance_status' and grantee = 'anon'
order by privilege_type;
-- EXPECT: only SELECT rows, on every column. No UPDATE/INSERT/DELETE for anon.

\echo '=== 5. Grants on maintenance_status — authenticated UPDATE is column-limited ==='
select grantee, privilege_type, column_name
from information_schema.role_column_grants
where table_name = 'maintenance_status' and grantee = 'authenticated' and privilege_type = 'UPDATE'
order by column_name;
-- EXPECT: exactly force_maintenance, title, message, starts_at, ends_at.
-- environment / updated_at / updated_by must NOT appear here.

\echo '=== 6. No INSERT/DELETE grant to anon or authenticated on maintenance_status ==='
select grantee, privilege_type
from information_schema.role_table_grants
where table_name = 'maintenance_status' and grantee in ('anon', 'authenticated')
  and privilege_type in ('INSERT', 'DELETE');
-- EXPECT: zero rows

\echo '=== 7. maintenance_admins is not readable by anon at all ==='
select grantee, privilege_type
from information_schema.role_table_grants
where table_name = 'maintenance_admins' and grantee = 'anon';
-- EXPECT: zero rows

\echo '=== 8. No INSERT/UPDATE/DELETE grant to authenticated on maintenance_admins ==='
select grantee, privilege_type
from information_schema.role_table_grants
where table_name = 'maintenance_admins' and grantee = 'authenticated'
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
-- EXPECT: zero rows

rollback;

-- ============================================================================
-- Behavioral checks — RLS-ENFORCED, simulated as each role. Each block is its
-- own BEGIN...ROLLBACK so no permanent mutation occurs even for the intended
-- "should succeed" cases.
-- ============================================================================

\echo '=== 9. anon: SELECT allowed ==='
begin;
set local role anon;
select environment, force_maintenance from public.maintenance_status;
-- EXPECT: 2 rows returned (ALLOW)
rollback;

\echo '=== 10. anon: UPDATE denied ==='
begin;
set local role anon;
update public.maintenance_status set force_maintenance = true where environment = 'preview';
-- EXPECT: ERROR — permission denied (DENY)
rollback;

\echo '=== 11. anon: INSERT denied ==='
begin;
set local role anon;
insert into public.maintenance_status (environment) values ('preview') on conflict do nothing;
-- EXPECT: ERROR — permission denied (DENY)
rollback;

\echo '=== 12. anon: DELETE denied ==='
begin;
set local role anon;
delete from public.maintenance_status where environment = 'preview';
-- EXPECT: ERROR — permission denied (DENY)
rollback;

\echo '=== 13. ordinary authenticated non-admin: UPDATE denied ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-non_admin_uuid","role":"authenticated"}';
update public.maintenance_status set force_maintenance = true where environment = 'preview';
-- EXPECT: 0 rows affected (RLS silently filters — PostgREST surfaces this as no-op/404, not a hard error)
rollback;

\echo '=== 14. inactive admin (is_active=false): UPDATE denied ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-inactive_admin_uuid","role":"authenticated"}';
update public.maintenance_status set force_maintenance = true where environment = 'preview';
-- EXPECT: 0 rows affected
rollback;

\echo '=== 15. preview-only admin: preview UPDATE allowed ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-preview_admin_uuid","role":"authenticated"}';
update public.maintenance_status set title = 'test' where environment = 'preview'
  returning environment, title, updated_by, updated_at;
-- EXPECT: 1 row, updated_by = the preview_admin_uuid (server-derived, not client-sent),
-- updated_at = now() (server-derived)
rollback;

\echo '=== 16. preview-only admin: production UPDATE denied ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-preview_admin_uuid","role":"authenticated"}';
update public.maintenance_status set title = 'test' where environment = 'production';
-- EXPECT: 0 rows affected
rollback;

\echo '=== 17. production-authorized admin: production UPDATE allowed ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-production_admin_uuid","role":"authenticated"}';
update public.maintenance_status set title = 'test' where environment = 'production'
  returning environment, title, updated_by;
-- EXPECT: 1 row, updated_by = the production_admin_uuid
rollback;

\echo '=== 18. environment column cannot be written even by an authorized admin ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-production_admin_uuid","role":"authenticated"}';
update public.maintenance_status set environment = 'preview' where environment = 'production';
-- EXPECT: ERROR — permission denied for column environment (blocked by the
-- column-level grant, before RLS is even evaluated)
rollback;

\echo '=== 19. updated_by cannot be client-forged ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-production_admin_uuid","role":"authenticated"}';
update public.maintenance_status set updated_by = 'REPLACE-WITH-non_admin_uuid' where environment = 'production';
-- EXPECT: ERROR — permission denied for column updated_by (not in the grant)
rollback;

\echo '=== 20. updated_at cannot be client-forged ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-production_admin_uuid","role":"authenticated"}';
update public.maintenance_status set updated_at = '2000-01-01' where environment = 'production';
-- EXPECT: ERROR — permission denied for column updated_at (not in the grant)
rollback;

\echo '=== 21. self can read own maintenance_admins row ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-preview_admin_uuid","role":"authenticated"}';
select user_id, is_active, can_manage_preview, can_manage_production from public.maintenance_admins
where user_id = 'REPLACE-WITH-preview_admin_uuid'::uuid;
-- EXPECT: 1 row
rollback;

\echo '=== 22. cannot read another admin''s maintenance_admins row ==='
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"REPLACE-WITH-preview_admin_uuid","role":"authenticated"}';
select user_id from public.maintenance_admins where user_id = 'REPLACE-WITH-production_admin_uuid'::uuid;
-- EXPECT: 0 rows (RLS filters out rows that are not your own)
rollback;

\echo 'Checklist complete. Any row above marked EXPECT that did not match is a release blocker.'
