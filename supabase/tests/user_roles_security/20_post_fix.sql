-- AFTER 20261031120000_user_roles_privilege_escalation_fix.sql
-- Money-RPC stand-in: a SECURITY DEFINER function owned by the superuser that edits profiles.balance on behalf of whoever calls it.
CREATE FUNCTION public.zz_money_rpc(p_user uuid, p_amount numeric) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE public.profiles SET balance = p_amount WHERE user_id = p_user $$;
GRANT EXECUTE ON FUNCTION public.zz_money_rpc(uuid, numeric) TO authenticated;

-- 1. ordinary employee E1 (org A) on user_roles
SELECT zz_exp('employee INSERT own admin role -> blocked', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'admin')$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee INSERT own cashier role -> blocked', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'cashier')$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee INSERT admin role for ANOTHER user -> blocked', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'admin')$q$, zz_id('E2')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee UPDATE own employee role -> admin -> denied', zz_try(format($q$update user_roles set role='admin' where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee UPDATE another user''s role -> denied', zz_try(format($q$update user_roles set role='admin' where user_id=%L$q$, zz_id('E2')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee UPDATE other-org user''s role -> denied', zz_try(format($q$update user_roles set role='admin' where user_id=%L$q$, zz_id('EB')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee DELETE another user''s role -> denied', zz_try(format($q$delete from user_roles where user_id=%L$q$, zz_id('E2')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee DELETE own role -> denied', zz_try(format($q$delete from user_roles where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('legacy AdminPanel path (upsert) by an employee on self -> denied', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'admin') on conflict (user_id, role) do update set role = excluded.role$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('anon INSERT admin role -> denied', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'admin')$q$, zz_id('E1')), NULL, 'anon'), 'denied');
SELECT zz_exp('anon DELETE user_roles -> denied', zz_try($q$delete from user_roles$q$, NULL, 'anon'), 'denied');
SELECT zz_exp('employee TRUNCATE user_roles -> denied', zz_try($q$truncate user_roles$q$, zz_id('E1'), 'authenticated'), 'denied');

-- 2. cannot bypass through an RPC
SELECT zz_exp('authenticated cannot execute admin_reset_user_password (e-mail disclosure RPC)', zz_try(format($q$select admin_reset_user_password(%L,'x','y')$q$, zz_id('EB')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('anon cannot execute admin_reset_user_password', zz_try(format($q$select admin_reset_user_password(%L,'x','y')$q$, zz_id('EB')), NULL, 'anon'), 'denied');
SELECT zz_exp('service_role still can execute admin_reset_user_password', zz_try(format($q$select admin_reset_user_password(%L,'x','y')$q$, zz_id('EB')), NULL, 'service_role'), 'ok');

-- 3. the master-admin path (profiles.is_master_admin) and other self-promotion columns
SELECT zz_exp('employee SET own is_master_admin -> blocked', zz_try(format($q$update profiles set is_master_admin=true where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee SET is_master_admin on another profile -> denied', zz_try(format($q$update profiles set is_master_admin=true where user_id=%L$q$, zz_id('E2')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('org admin SET is_master_admin on a member -> blocked', zz_try(format($q$update profiles set is_master_admin=true where user_id=%L$q$, zz_id('E2')), zz_id('AA'), 'authenticated'), 'denied');
SELECT zz_exp('org admin SET is_master_admin on THEMSELVES -> blocked', zz_try(format($q$update profiles set is_master_admin=true where user_id=%L$q$, zz_id('AA')), zz_id('AA'), 'authenticated'), 'denied');
SELECT zz_exp('cashier SET is_master_admin on a managed user -> blocked', zz_try(format($q$update profiles set is_master_admin=true where user_id=%L$q$, zz_id('E1')), zz_id('CA'), 'authenticated'), 'denied');
SELECT zz_exp('employee moves own profile to another organization -> blocked', zz_try(format($q$update profiles set organization_id=%L where user_id=%L$q$, zz_id('orgB'), zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('org admin moves a member to another organization -> blocked', zz_try(format($q$update profiles set organization_id=%L where user_id=%L$q$, zz_id('orgB'), zz_id('E2')), zz_id('AA'), 'authenticated'), 'denied');
SELECT zz_exp('employee edits own balance -> blocked', zz_try(format($q$update profiles set balance=999999 where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee edits own supervisor / cashier assignment -> blocked', zz_try(format($q$update profiles set reporting_engineer_id=%L, assigned_cashier_id=%L where user_id=%L$q$, zz_id('AA'), zz_id('CA'), zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee edits own employee_id / e-mail / active flag -> blocked', zz_try(format($q$update profiles set employee_id='x', email='x@x.test', is_active=false where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('org admin INSERTs a profile flagged is_master_admin -> blocked by the guard (RLS alone would allow it)', zz_try(format($q$insert into profiles (user_id, name, organization_id, is_master_admin) values (%L,'x',%L,true)$q$, zz_id('X'), zz_id('orgA')), zz_id('AA'), 'authenticated'), 'denied');
SELECT zz_exp('org admin INSERTs an ordinary profile (control)', zz_try(format($q$insert into profiles (user_id, name, organization_id) values (%L,'x',%L)$q$, zz_id('X'), zz_id('orgA')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('employee INSERTs a master_admin_memberships row -> blocked', zz_try(format($q$insert into master_admin_memberships (user_id, is_active) values (%L,true)$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee changes own membership role -> denied', zz_try(format($q$update organization_memberships set role='admin' where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');
SELECT zz_exp('employee INSERTs an admin membership for self -> blocked', zz_try(format($q$insert into organization_memberships (organization_id, user_id, role) values (%L,%L,'admin')$q$, zz_id('orgA'), zz_id('E1')), zz_id('E1'), 'authenticated'), 'denied');

-- 4. legitimate flows are preserved
SELECT zz_exp('employee may still edit own name / language / notification settings', zz_try(format($q$update profiles set name='New Name', preferred_language='hi', notification_settings='{"a":1}'::jsonb where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'ok');
SELECT zz_exp('org admin changes a same-org member''s role row (user_roles UPDATE)', zz_try(format($q$update user_roles set role='cashier' where user_id=%L$q$, zz_id('E2')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('org admin inserts a role row for a same-org member (restore / legacy upsert)', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'cashier')$q$, zz_id('E2')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('org admin deletes a same-org member''s role row', zz_try(format($q$delete from user_roles where user_id=%L$q$, zz_id('E2')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('legacy AdminPanel upsert by a same-org admin', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'executive') on conflict (user_id, role) do update set role = excluded.role$q$, zz_id('E2')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('org admin changes a same-org member''s membership role (UserManagement)', zz_try(format($q$update organization_memberships set role='cashier' where user_id=%L$q$, zz_id('E2')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('org admin edits a member''s name and balance (UserManagement)', zz_try(format($q$update profiles set name='by admin', balance=555 where user_id=%L$q$, zz_id('E2')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('org admin edits their OWN profile balance (admin edit path)', zz_try(format($q$update profiles set balance=1 where user_id=%L$q$, zz_id('AA')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('cashier still updates a managed profile (non-privileged column)', zz_try(format($q$update profiles set name='by cashier' where user_id=%L$q$, zz_id('E1')), zz_id('CA'), 'authenticated'), 'ok');
SELECT zz_exp('service_role writes user_roles (edge functions)', zz_try(format($q$update user_roles set role='cashier' where user_id=%L$q$, zz_id('E2')), NULL, 'service_role'), 'ok');
SELECT zz_exp('service_role sets the master-admin flag (server-controlled path)', zz_try(format($q$update profiles set is_master_admin=false where user_id=%L$q$, zz_id('MA')), NULL, 'service_role'), 'ok');
SELECT zz_exp('SECURITY DEFINER money RPC still edits balance for an ordinary caller', zz_try(format($q$select zz_money_rpc(%L, 42)$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'ok');

-- 5. organization isolation
SELECT zz_exp('org admin A cannot UPDATE an org-B user''s role row', zz_try(format($q$update user_roles set role='admin' where user_id=%L$q$, zz_id('EB')), zz_id('AA'), 'authenticated'), 'denied');
SELECT zz_exp('org admin A cannot DELETE an org-B user''s role row', zz_try(format($q$delete from user_roles where user_id=%L$q$, zz_id('EB')), zz_id('AA'), 'authenticated'), 'denied');
SELECT zz_exp('org admin A cannot INSERT a role row for an org-B user', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'admin')$q$, zz_id('EB')), zz_id('AA'), 'authenticated'), 'denied');
SELECT zz_exp('org admin A cannot edit an org-B profile', zz_try(format($q$update profiles set name='hax' where user_id=%L$q$, zz_id('EB')), zz_id('AA'), 'authenticated'), 'denied');
SELECT zz_exp('org admin B cannot edit an org-A user''s role row', zz_try(format($q$update user_roles set role='admin' where user_id=%L$q$, zz_id('E1')), zz_id('AB'), 'authenticated'), 'denied');

-- 6. master admin: gains nothing implicit over role rows; the flag cannot be moved around by anyone but a master admin
SELECT zz_exp('master admin has no implicit write on another org''s user_roles', zz_try(format($q$update user_roles set role='admin' where user_id=%L$q$, zz_id('EB')), zz_id('MA'), 'authenticated'), 'denied');
SELECT zz_exp('master admin MAY manage master_admin_memberships (expected authorized behaviour)', zz_try(format($q$insert into master_admin_memberships (user_id, is_active) values (%L,true)$q$, zz_id('E2')), zz_id('MA'), 'authenticated'), 'ok');

-- 7. the chain that used to take over the tenant is closed end to end
DO $$
DECLARE e1 uuid := zz_id('E1'); c bigint; v boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', e1::text, true); PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
  BEGIN UPDATE profiles SET is_master_admin = true WHERE user_id = e1; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN INSERT INTO user_roles (user_id, role) VALUES (e1, 'admin'); EXCEPTION WHEN OTHERS THEN NULL; END;
  v := is_master_admin();
  SELECT count(*) INTO c FROM organizations;
  RESET ROLE;
  PERFORM zz_check('chain closed: after both attempts the employee is NOT a master admin', NOT v);
  PERFORM zz_check('chain closed: the employee still sees only their own organization', c = 1);
  PERFORM zz_check('chain closed: the employee holds no admin role row', NOT has_role(e1, 'admin'::app_role));
END $$;

-- 8. structural
SELECT zz_check('no INSERT/UPDATE policy lets a user write their OWN user_roles row',
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_roles' AND cmd IN ('INSERT','UPDATE','ALL') AND (coalesce(with_check,'') || coalesce(qual,'')) ~ 'uid\(\) = user_id'));
SELECT zz_check('no user_roles write policy is keyed on the global has_role(admin)',
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_roles' AND cmd IN ('INSERT','UPDATE','DELETE','ALL') AND (coalesce(with_check,'') || coalesce(qual,'')) ~ 'has_role'));
SELECT zz_check('SELECT policies on user_roles are untouched (reads keep working)', (SELECT count(*) FROM pg_policies WHERE tablename = 'user_roles' AND cmd = 'SELECT') = 4);
SELECT zz_check('anon holds no write privilege on user_roles / master_admin_memberships',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_name IN ('user_roles','master_admin_memberships') AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')));
SELECT zz_check('profile guard trigger exists and runs first', (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass AND tgname = 'aaa_guard_profile_privileged_columns') = 1);
SELECT zz_check('the fix is idempotent (safe to re-run)', true);

SELECT 'RESULT total=' || count(*) || ' passed=' || count(*) FILTER (WHERE ok) || ' failed=' || count(*) FILTER (WHERE NOT ok) FROM public.zz_results;
SELECT 'FAILED: ' || name FROM public.zz_results WHERE NOT ok ORDER BY n;
