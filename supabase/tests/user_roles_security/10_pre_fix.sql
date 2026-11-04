-- BEFORE the fix: prove the harness is faithful by reproducing the vulnerabilities on Production's verbatim policies.
CREATE FUNCTION public.zz_exp(p_name text, p_got text, p_want text) RETURNS void LANGUAGE sql AS $$
  SELECT public.zz_check(p_name, CASE p_want WHEN 'denied' THEN p_got IN ('blocked','noop') ELSE p_got = p_want END) $$;
SELECT zz_exp('BASELINE (pre-fix) reproduces: employee inserts their own admin role', zz_try(format($q$insert into user_roles (user_id, role) values (%L,'admin')$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'ok');
SELECT zz_exp('BASELINE (pre-fix) reproduces: employee promotes their own user_roles row to admin', zz_try(format($q$update user_roles set role='admin' where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'ok');
SELECT zz_exp('BASELINE (pre-fix) reproduces: employee sets their own is_master_admin', zz_try(format($q$update profiles set is_master_admin=true where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'ok');
SELECT zz_exp('BASELINE (pre-fix) reproduces: employee edits their own balance', zz_try(format($q$update profiles set balance=999999 where user_id=%L$q$, zz_id('E1')), zz_id('E1'), 'authenticated'), 'ok');
SELECT zz_exp('BASELINE (pre-fix) reproduces: an org-A admin deletes an org-B user''s role row', zz_try(format($q$delete from user_roles where user_id=%L$q$, zz_id('EB')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('BASELINE (pre-fix) reproduces: an org admin flips is_master_admin on another user', zz_try(format($q$update profiles set is_master_admin=true where user_id=%L$q$, zz_id('E2')), zz_id('AA'), 'authenticated'), 'ok');
SELECT zz_exp('BASELINE (pre-fix) reproduces: a cashier flips is_master_admin on a managed user', zz_try(format($q$update profiles set is_master_admin=true where user_id=%L$q$, zz_id('E1')), zz_id('CA'), 'authenticated'), 'ok');
SELECT zz_exp('BASELINE (pre-fix) reproduces: authenticated may execute admin_reset_user_password', zz_try(format($q$select admin_reset_user_password(%L,'x','y')$q$, zz_id('EB')), zz_id('E1'), 'authenticated'), 'ok');
INSERT INTO auth.users (id, email) SELECT gen_random_uuid(), 'x@example.test';
INSERT INTO zz_ids SELECT 'X', id FROM auth.users WHERE email = 'x@example.test';
SELECT zz_exp('BASELINE (pre-fix) reproduces: an org admin inserts a profile flagged is_master_admin', zz_try(format($q$insert into profiles (user_id, name, organization_id, is_master_admin) values (%L,'x',%L,true)$q$, zz_id('X'), zz_id('orgA')), zz_id('AA'), 'authenticated'), 'ok');
