-- DOC-158 acceptance test. Run AFTER 00_harness.sql and the real migration, on a THROWAWAY database.
CREATE FUNCTION public.zz_get(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v::uuid FROM public.zz_ctx WHERE k = p_k $$;
CREATE FUNCTION public.zz_last(p_target uuid, p_type text, p_field text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(e) FROM public.user_account_audit_events e WHERE e.target_user_id = p_target AND e.event_type = p_type
     AND (p_field IS NULL OR e.field_name = p_field) ORDER BY e.created_at DESC, e.id DESC LIMIT 1 $$;
CREATE FUNCTION public.zz_cnt(p_target uuid) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM public.user_account_audit_events WHERE target_user_id = p_target $$;

-- ------------------------------------------------------------------ 0. migration-time backfill (hard evidence only)
DO $$
DECLARE l uuid := zz_get('legacy_emp'); a uuid := zz_get('legacy_admin'); bf jsonb; bs jsonb;
BEGIN
  bs := zz_last(l, 'baseline_snapshot');
  PERFORM zz_check('backfill: baseline snapshot exists for a pre-existing account', bs IS NOT NULL);
  PERFORM zz_check('backfill: baseline is honest (migration actor, no guessed human)', bs ->> 'actor_user_id' IS NULL AND bs ->> 'actor_type' = 'migration');
  bf := zz_last(l, 'user_deactivated');
  PERFORM zz_check('backfill: legacy deactivation carried over with its RECORDED actor', (bf ->> 'actor_user_id')::uuid = a AND bf ->> 'source' = 'historical_backfill');
  PERFORM zz_check('backfill: no historical identity invented (snapshot unavailable, flagged)', bf -> 'target_snapshot' = 'null'::jsonb AND (bf -> 'metadata' ->> 'snapshot_unavailable')::boolean);
  PERFORM zz_check('backfill: evidence source recorded', bf -> 'metadata' ->> 'evidence_source' = 'account_audit_events');
END $$;

-- ------------------------------------------------------------------ setup: two orgs, admins, supervisor, cashier, location, team
DO $$
DECLARE oa uuid := gen_random_uuid(); ob uuid := gen_random_uuid(); aa uuid := gen_random_uuid(); ab uuid := gen_random_uuid();
        s uuid := gen_random_uuid(); c uuid := gen_random_uuid(); loc uuid := gen_random_uuid(); t uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
BEGIN
  INSERT INTO organizations (id, name) VALUES (oa, 'ZZ Org A'), (ob, 'ZZ Org B');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (aa, 'admin-a@example.test', jsonb_build_object('name', 'Admin A', 'organization_id', oa)),
    (ab, 'admin-b@example.test', jsonb_build_object('name', 'Admin B', 'organization_id', ob)),
    (s,  'sup@example.test',     jsonb_build_object('name', 'Supervisor S', 'organization_id', oa)),
    (c,  'cashier@example.test', jsonb_build_object('name', 'Cashier C', 'organization_id', oa));
  INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (oa, aa, 'admin'), (ob, ab, 'admin'), (oa, s, 'manager'), (oa, c, 'cashier');
  INSERT INTO locations (id, name, organization_id) VALUES (loc, 'Surat Branch', oa);
  INSERT INTO teams (id, organization_id, name) VALUES (t, oa, 'Team One'), (t2, oa, 'Team Two');
  INSERT INTO zz_ctx VALUES ('orgA', oa::text), ('orgB', ob::text), ('adminA', aa::text), ('adminB', ab::text), ('sup', s::text), ('cashier', c::text),
    ('loc', loc::text), ('team1', t::text), ('team2', t2::text);
END $$;

-- ------------------------------------------------------------------ 1. CREATE USER via the service-role path (Krish Test)
DO $$
DECLARE oa uuid := zz_get('orgA'); aa uuid := zz_get('adminA'); k uuid := gen_random_uuid(); e jsonb; m jsonb;
BEGIN
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-create-1', 'user_management', NULL, 'krish-test@example.test');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (k, 'krish-test@example.test', jsonb_build_object('name', 'Krish Test', 'organization_id', oa));
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-create-1', 'user_management', ARRAY[k]);
  INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (oa, k, 'employee');
  RESET ROLE; PERFORM zz_clear();
  INSERT INTO zz_ctx VALUES ('K', k::text);
  e := zz_last(k, 'user_created'); m := zz_last(k, 'membership_added');
  PERFORM zz_check('create user: event recorded for the new account', e IS NOT NULL);
  PERFORM zz_check('create user: HUMAN actor preserved through service role (not service_role)', (e ->> 'actor_user_id')::uuid = aa AND e ->> 'actor_type' = 'org_admin');
  PERFORM zz_check('create user: execution context recorded as service_role in metadata', e -> 'metadata' ->> 'execution_context' = 'service_role');
  PERFORM zz_check('create user: request id propagated', e ->> 'request_id' = 'req-create-1' AND m ->> 'request_id' = 'req-create-1');
  PERFORM zz_check('create user: membership attributed to the same human', (m ->> 'actor_user_id')::uuid = aa);
  PERFORM zz_check('create user: target snapshot captured', e -> 'target_snapshot' ->> 'name' = 'Krish Test' AND e -> 'target_snapshot' ->> 'email' = 'krish-test@example.test');
  PERFORM zz_check('create user: actor snapshot frozen with name', e -> 'actor_snapshot' ->> 'name' = 'Admin A');
END $$;

-- 1b. the membership written INSIDE the auth-user insert (before any id-keyed context can exist) is still attributed, via the e-mail context
DO $$
DECLARE oa uuid := zz_get('orgA'); aa uuid := zz_get('adminA'); k2 uuid := gen_random_uuid(); m jsonb;
BEGIN
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-create-2', 'user_management', NULL, 'auto-member@example.test');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (k2, 'auto-member@example.test', jsonb_build_object('name', 'Auto Member', 'organization_id', oa, 'auto_membership', 'true'));
  RESET ROLE; PERFORM zz_clear();
  m := zz_last(k2, 'membership_added');
  PERFORM zz_check('create user: membership inserted by handle_new_user is attributed to the human admin (e-mail context)',
    m IS NOT NULL AND (m ->> 'actor_user_id')::uuid = aa AND m ->> 'request_id' = 'req-create-2');
END $$;

-- ------------------------------------------------------------------ 2. employee ID, role, supervisor, cashier, team, location as the signed-in admin
DO $$
DECLARE k uuid := zz_get('K'); aa uuid := zz_get('adminA'); s uuid := zz_get('sup'); c uuid := zz_get('cashier'); loc uuid := zz_get('loc');
        t1 uuid := zz_get('team1'); t2 uuid := zz_get('team2'); oa uuid := zz_get('orgA'); e jsonb; n0 bigint; r1 text; r2 text;
BEGIN
  DELETE FROM user_account_audit_context;  -- start from a clean slate: these steps are attributed from the JWT alone
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE profiles SET employee_id = 'e-100' WHERE user_id = k;
  RESET ROLE;
  e := zz_last(k, 'employee_id_changed');
  PERFORM zz_check('employee id change audited with actor/old/new', (e ->> 'actor_user_id')::uuid = aa AND e -> 'old_value' = 'null'::jsonb AND e -> 'new_value' = '"e-100"'::jsonb);
  PERFORM zz_check('employee id change: source is user_management, execution authenticated', e ->> 'source' = 'user_management' AND e -> 'metadata' ->> 'execution_context' = 'authenticated');

  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE organization_memberships SET role = 'manager' WHERE user_id = k;
  RESET ROLE;
  e := zz_last(k, 'role_changed');
  PERFORM zz_check('role change audited old -> new', e -> 'old_value' = '"employee"'::jsonb AND e -> 'new_value' = '"manager"'::jsonb AND (e ->> 'actor_user_id')::uuid = aa);
  PERFORM zz_check('role change: derived user_roles row is NOT double-reported', zz_last(k, 'legacy_role_changed') IS NULL);

  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE profiles SET reporting_engineer_id = s WHERE user_id = k;
  RESET ROLE;
  e := zz_last(k, 'supervisor_changed');
  PERFORM zz_check('supervisor change audited with frozen label', e -> 'metadata' ->> 'new_label' = 'Supervisor S' AND e -> 'old_value' = 'null'::jsonb);

  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE profiles SET assigned_cashier_id = c WHERE user_id = k;
  UPDATE profiles SET cashier_assigned_location_id = loc WHERE user_id = k;
  RESET ROLE;
  PERFORM zz_check('cashier assignment change audited', zz_last(k, 'cashier_assignment_changed', 'assigned_cashier_id') -> 'metadata' ->> 'new_label' = 'Cashier C');
  PERFORM zz_check('cashier location assignment audited with label', zz_last(k, 'cashier_assignment_changed', 'cashier_assigned_location_id') -> 'metadata' ->> 'new_label' = 'Surat Branch');

  -- team move = delete + insert in one request
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  INSERT INTO team_members (team_id, user_id, organization_id) VALUES (t1, k, oa);
  DELETE FROM team_members WHERE user_id = k;
  INSERT INTO team_members (team_id, user_id, organization_id) VALUES (t2, k, oa);
  RESET ROLE;
  e := zz_last(k, 'team_changed');
  PERFORM zz_check('team change audited (joined Team Two)', e -> 'metadata' ->> 'new_label' = 'Team Two' AND (e ->> 'actor_user_id')::uuid = aa);
  SELECT count(DISTINCT request_id) INTO n0 FROM user_account_audit_events WHERE target_user_id = k AND event_type = 'team_changed';
  PERFORM zz_check('team move events share ONE request id (same transaction)', n0 = 1);

  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  INSERT INTO engineer_locations (engineer_id, location_id, organization_id) VALUES (k, loc, oa);
  RESET ROLE;
  PERFORM zz_check('location change audited', zz_last(k, 'location_changed') -> 'metadata' ->> 'new_label' = 'Surat Branch');
END $$;

-- ------------------------------------------------------------------ 3. deactivate / reactivate / ban / unban (kept distinct)
DO $$
DECLARE k uuid := zz_get('K'); aa uuid := zz_get('adminA'); oa uuid := zz_get('orgA'); e jsonb;
BEGIN
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE organization_memberships SET is_active = false WHERE user_id = k;
  RESET ROLE;
  e := zz_last(k, 'user_deactivated');
  PERFORM zz_check('deactivate audited with actor', (e ->> 'actor_user_id')::uuid = aa);
  PERFORM zz_check('deactivate records MEMBERSHIP transition separately from profile/auth states',
    (e -> 'metadata' -> 'membership_active' ->> 'old')::boolean AND NOT (e -> 'metadata' -> 'membership_active' ->> 'new')::boolean
    AND e -> 'metadata' ? 'profile_active' AND e -> 'metadata' ? 'auth_banned' AND e ->> 'field_name' = 'membership.is_active');

  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE organization_memberships SET is_active = true WHERE user_id = k;
  RESET ROLE;
  PERFORM zz_check('reactivate audited with actor', (zz_last(k, 'user_reactivated') ->> 'actor_user_id')::uuid = aa);

  -- auth ban through the service role with a registered human context
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-ban-1', 'auth_admin', ARRAY[k]);
  UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id = k;
  RESET ROLE; PERFORM zz_clear();
  e := zz_last(k, 'user_banned');
  PERFORM zz_check('ban audited, human actor preserved through service role', (e ->> 'actor_user_id')::uuid = aa AND e -> 'metadata' ->> 'execution_context' = 'service_role' AND e ->> 'request_id' = 'req-ban-1');
  PERFORM zz_check('ban is a distinct auth-layer event (field auth.banned)', e ->> 'field_name' = 'auth.banned' AND e -> 'metadata' ->> 'layer' = 'auth');

  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-unban-1', 'auth_admin', ARRAY[k]);
  UPDATE auth.users SET banned_until = NULL WHERE id = k;
  RESET ROLE; PERFORM zz_clear();
  PERFORM zz_check('unban audited with actor', (zz_last(k, 'user_unbanned') ->> 'actor_user_id')::uuid = aa);
END $$;

-- ------------------------------------------------------------------ 4. email change (auth layer via service role + profile layer by the admin), then name change
DO $$
DECLARE k uuid := zz_get('K'); aa uuid := zz_get('adminA'); oa uuid := zz_get('orgA'); ea jsonb; ep jsonb; en jsonb;
BEGIN
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-email-1', 'user_management', ARRAY[k]);
  UPDATE auth.users SET email = 'dakshit-test@example.test' WHERE id = k;
  RESET ROLE; PERFORM zz_clear();
  ea := zz_last(k, 'email_changed', 'auth.email');
  PERFORM zz_check('email change (auth) audited old -> new', ea -> 'old_value' = '"krish-test@example.test"'::jsonb AND ea -> 'new_value' = '"dakshit-test@example.test"'::jsonb);
  PERFORM zz_check('email change (auth): human admin, NOT service_role', (ea ->> 'actor_user_id')::uuid = aa AND ea ->> 'actor_type' = 'org_admin' AND ea -> 'metadata' ->> 'execution_context' = 'service_role');

  -- the browser then updates profiles.email as the SAME admin (still inside the context window)
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE profiles SET email = 'dakshit-test@example.test' WHERE user_id = k;
  RESET ROLE;
  ep := zz_last(k, 'email_changed', 'email');
  PERFORM zz_check('email change (profile mirror) audited', ep -> 'new_value' = '"dakshit-test@example.test"'::jsonb AND (ep ->> 'actor_user_id')::uuid = aa);
  PERFORM zz_check('request-id correlation: auth and profile email events share one request id', ea ->> 'request_id' = 'req-email-1' AND ep ->> 'request_id' = 'req-email-1');
  PERFORM zz_check('email change snapshot shows the OLD identity', ep -> 'target_snapshot' ->> 'email' = 'krish-test@example.test');
END $$;

DO $$
DECLARE k uuid := zz_get('K'); aa uuid := zz_get('adminA'); e jsonb; ex uuid := gen_random_uuid(); oa uuid := zz_get('orgA'); sm jsonb; sm2 jsonb; id1 uuid;
BEGIN
  -- historical business record that must never move
  INSERT INTO expenses (id, user_id, organization_id, created_by, submitted_by) VALUES (ex, k, oa, k, k);
  INSERT INTO audit_logs (user_id) VALUES (k);

  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE profiles SET name = 'Dakshit Prajapati' WHERE user_id = k;
  RESET ROLE;
  e := zz_last(k, 'profile_updated', 'name');
  PERFORM zz_check('name change audited old -> new', e -> 'old_value' = '"Krish Test"'::jsonb AND e -> 'new_value' = '"Dakshit Prajapati"'::jsonb AND (e ->> 'actor_user_id')::uuid = aa);
  PERFORM zz_check('HISTORICAL SNAPSHOT: old events still say "Krish Test" after the rename',
    (SELECT target_snapshot ->> 'name' FROM user_account_audit_events WHERE target_user_id = k AND event_type = 'user_created') = 'Krish Test');
  PERFORM zz_check('name-change snapshot is the identity BEFORE the change', e -> 'target_snapshot' ->> 'name' = 'Krish Test');

  -- name + email together on an account WITH history -> warning data + confirmation
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  sm := get_user_identity_history_summary_v1(oa, k);
  id1 := record_account_identity_change_confirmation_v1(oa, k, 'Someone Else', 'someone-else@example.test');
  RESET ROLE;
  PERFORM zz_check('reassignment warning: summary reports historical activity', (sm ->> 'expense_count')::int = 1 AND (sm ->> 'has_history')::boolean AND sm ? 'account_created_at');
  e := zz_last(k, 'account_identity_changed');
  PERFORM zz_check('account_identity_changed records the confirmation by the real admin', (e ->> 'actor_user_id')::uuid = aa AND (e -> 'metadata' ->> 'confirmed_by_admin')::boolean);
  PERFORM zz_check('account_identity_changed carries old (from DB) and declared new identity',
    e -> 'old_value' ->> 'name' = 'Dakshit Prajapati' AND e -> 'new_value' ->> 'email' = 'someone-else@example.test');

  PERFORM zz_check('HISTORICAL EXPENSE OWNERSHIP unchanged after rename + email change',
    (SELECT user_id FROM expenses WHERE id = ex) = k AND (SELECT created_by FROM expenses WHERE id = ex) = k AND (SELECT submitted_by FROM expenses WHERE id = ex) = k
    AND (SELECT user_id FROM audit_logs WHERE user_id = k LIMIT 1) = k);
  PERFORM zz_check('auth user id is stable across email/name changes', EXISTS (SELECT 1 FROM auth.users WHERE id = k AND email = 'dakshit-test@example.test'));
END $$;

-- ------------------------------------------------------------------ 5. passwords: events only, never values
DO $$
DECLARE k uuid := zz_get('K'); aa uuid := zz_get('adminA'); oa uuid := zz_get('orgA'); e jsonb; ea jsonb; n0 bigint; bad bigint;
BEGIN
  -- admin password reset (edge function: register context, auth update, explicit event)
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-pw-1', 'password_reset', ARRAY[k], NULL, NULL, 'target', 120, 'admin_reset');
  UPDATE auth.users SET encrypted_password = '$2a$10$ADMINRESETHASHVALUEexample0123456789abcdefghijkl' WHERE id = k;
  PERFORM record_user_account_audit_event_v1(oa, k, aa, 'admin_password_reset', 'password_reset', 'req-pw-1', jsonb_build_object('method', 'admin_reset'));
  RESET ROLE; PERFORM zz_clear();
  e := zz_last(k, 'password_changed'); ea := zz_last(k, 'admin_password_reset');
  PERFORM zz_check('admin password reset: trigger event attributed to the admin', (e ->> 'actor_user_id')::uuid = aa AND e ->> 'source' = 'password_reset' AND e -> 'metadata' ->> 'method' = 'admin_reset');
  PERFORM zz_check('admin password reset: explicit event recorded with the same request id', (ea ->> 'actor_user_id')::uuid = aa AND ea ->> 'request_id' = 'req-pw-1');
  PERFORM zz_check('password event has NO values (field, old, new all empty)', e -> 'old_value' = 'null'::jsonb AND e -> 'new_value' = 'null'::jsonb AND e ->> 'field_name' IS NULL);

  -- self-service change: the signed-in user registers, GoTrue (no claims) writes
  PERFORM zz_as(k, 'authenticated'); SET LOCAL ROLE authenticated;
  PERFORM register_my_account_audit_context_v1('account_settings', 'self_service');
  RESET ROLE; PERFORM zz_clear();
  UPDATE auth.users SET encrypted_password = '$2a$10$SELFSERVICEHASHVALUEexample0123456789abcdefghijklm' WHERE id = k;
  e := zz_last(k, 'password_changed');
  PERFORM zz_check('self password change: actor is the user, source account_settings, method self_service',
    (e ->> 'actor_user_id')::uuid = k AND e ->> 'source' = 'account_settings' AND e -> 'metadata' ->> 'method' = 'self_service' AND e ->> 'actor_type' = 'user');

  -- no context at all (recovery link, direct SQL): recorded as UNATTRIBUTED, never guessed
  DELETE FROM user_account_audit_context;
  UPDATE auth.users SET encrypted_password = '$2a$10$UNATTRIBUTEDHASHexample0123456789abcdefghijklmnopq' WHERE id = k;
  e := zz_last(k, 'password_changed');
  PERFORM zz_check('unattributed password change is flagged, actor NULL (not guessed)', e ->> 'actor_user_id' IS NULL AND e -> 'metadata' ->> 'attribution' = 'unattributed');

  -- values never stored anywhere
  SELECT count(*) INTO bad FROM user_account_audit_events e2
   WHERE to_jsonb(e2)::text ~* '(ADMINRESETHASH|SELFSERVICEHASH|UNATTRIBUTEDHASH|\$2a\$10)';
  PERFORM zz_check('PASSWORD values/hashes never appear in any audit row', bad = 0);
  SELECT count(*) INTO bad FROM user_account_audit_events e2 WHERE to_jsonb(e2)::text ~ 'eyJ[A-Za-z0-9_-]{8,}\.';
  PERFORM zz_check('JWT-looking strings never appear in any audit row', bad = 0);
END $$;

-- ------------------------------------------------------------------ 6. scrubber: secrets are dropped/redacted even if a caller tries to log them
DO $$
DECLARE oa uuid := zz_get('orgA'); aa uuid := zz_get('adminA'); k uuid := zz_get('K'); e jsonb; txt text;
BEGIN
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM record_user_account_audit_event_v1(oa, k, aa, 'password_reset_requested', 'auth_recovery', 'req-scrub-1',
    jsonb_build_object('password', 'PlainTextSecret!', 'new_password', 'PlainTextSecret2!', 'refresh_token', 'rt-123', 'access_token', 'at-456',
                       'service_role_key', 'srk', 'otp', '123456', 'nested', jsonb_build_object('session_token', 'st', 'ok', 'fine'),
                       'note', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturepart', 'reason', 'user_requested'),
    NULL, to_jsonb('$2b$12$bcrypthashshouldberedactedxxxxxxxxxxxxxxxxxxxxxxxx'::text), NULL);
  RESET ROLE; PERFORM zz_clear();
  e := zz_last(k, 'password_reset_requested'); txt := e::text;
  PERFORM zz_check('scrub: password/token/otp/key fields dropped from metadata', txt !~* 'PlainTextSecret|rt-123|at-456|srk|"otp"|session_token');
  PERFORM zz_check('scrub: harmless metadata kept', e -> 'metadata' -> 'nested' ->> 'ok' = 'fine' AND e -> 'metadata' ->> 'reason' = 'user_requested');
  PERFORM zz_check('scrub: JWT value redacted', e -> 'metadata' ->> 'note' = '[redacted]');
  PERFORM zz_check('scrub: bcrypt hash value redacted', e -> 'old_value' = '"[redacted]"'::jsonb);
END $$;

-- ------------------------------------------------------------------ 7. noise control: unchanged values never logged
DO $$
DECLARE k uuid := zz_get('K'); aa uuid := zz_get('adminA'); n0 bigint; n1 bigint;
BEGIN
  n0 := zz_cnt(k);
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE profiles SET name = name, employee_id = employee_id, email = email WHERE user_id = k;
  UPDATE organization_memberships SET role = role, is_active = is_active WHERE user_id = k;
  UPDATE profiles SET balance = 12345, preferred_language = 'hi', notification_settings = '{"a":1}'::jsonb WHERE user_id = k;
  RESET ROLE;
  n1 := zz_cnt(k);
  PERFORM zz_check('unchanged values and excluded fields (balance, language, notifications) create NO events', n0 = n1);
  PERFORM zz_check('balance is never recorded in any audit row', NOT EXISTS (SELECT 1 FROM user_account_audit_events WHERE field_name IN ('balance') OR to_jsonb(user_account_audit_events)::text ~ '12345'));
END $$;

-- ------------------------------------------------------------------ 8. bulk import: per-user events correlated by one batch id / request id
DO $$
DECLARE oa uuid := zz_get('orgA'); aa uuid := zz_get('adminA'); u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
        e1 jsonb; e2 jsonb; e3 jsonb; n int;
BEGIN
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-bulk-ABC', 'bulk_upload', NULL, NULL, 'batch-ABC', 'organization', 900);
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (u1, 'bulk1@example.test', jsonb_build_object('name', 'Bulk One', 'organization_id', oa)),
    (u2, 'bulk2@example.test', jsonb_build_object('name', 'Bulk Two', 'organization_id', oa)),
    (u3, 'bulk3@example.test', jsonb_build_object('name', 'Bulk Three', 'organization_id', oa));
  INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (oa, u1, 'employee'), (oa, u2, 'employee'), (oa, u3, 'employee');
  UPDATE profiles SET employee_id = 'b-2' WHERE user_id = u2;
  UPDATE organization_memberships SET role = 'manager' WHERE user_id = u3;
  PERFORM clear_user_account_audit_context_v1('req-bulk-ABC');
  RESET ROLE; PERFORM zz_clear();
  e1 := zz_last(u1, 'user_created'); e2 := zz_last(u2, 'employee_id_changed'); e3 := zz_last(u3, 'role_changed');
  PERFORM zz_check('bulk: per-user events exist for create / employee id / role', e1 IS NOT NULL AND e2 IS NOT NULL AND e3 IS NOT NULL);
  PERFORM zz_check('bulk: all events attributed to the importing admin', (e1 ->> 'actor_user_id')::uuid = aa AND (e2 ->> 'actor_user_id')::uuid = aa AND (e3 ->> 'actor_user_id')::uuid = aa);
  PERFORM zz_check('bulk: shared batch id and request id correlate the rows', e1 ->> 'batch_id' = 'batch-ABC' AND e2 ->> 'batch_id' = 'batch-ABC' AND e3 ->> 'request_id' = 'req-bulk-ABC');
  SELECT count(DISTINCT target_user_id) INTO n FROM user_account_audit_events WHERE batch_id = 'batch-ABC';
  PERFORM zz_check('bulk: one separate audit trail per affected user', n = 3);
  -- after the context is cleared, a service-role write is no longer attributed to that admin
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  UPDATE profiles SET employee_id = 'b-9' WHERE user_id = u1;
  RESET ROLE; PERFORM zz_clear();
  PERFORM zz_check('after the bulk context is cleared, service-role writes are unattributed (never inherited)',
    zz_last(u1, 'employee_id_changed') ->> 'actor_user_id' IS NULL AND zz_last(u1, 'employee_id_changed') ->> 'actor_type' = 'service_role');
  INSERT INTO zz_ctx VALUES ('bulkU3', u3::text);
END $$;

-- ------------------------------------------------------------------ 9. anti-spoofing
DO $$
DECLARE oa uuid := zz_get('orgA'); aa uuid := zz_get('adminA'); ab uuid := zz_get('adminB'); k uuid := zz_get('K'); c uuid := zz_get('cashier');
        ok boolean; e jsonb;
BEGIN
  -- (a) service role tries to register a NON-admin as the actor
  ok := false; PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  BEGIN PERFORM register_user_account_audit_context_v1(k, oa, 'req-spoof-1', 'user_management', ARRAY[c]); EXCEPTION WHEN OTHERS THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('anti-spoof: a non-admin cannot be registered as the actor', ok);
  -- (b) an admin of ANOTHER org cannot be registered for this org
  ok := false; PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  BEGIN PERFORM register_user_account_audit_context_v1(ab, oa, 'req-spoof-2', 'user_management', ARRAY[c]); EXCEPTION WHEN OTHERS THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('anti-spoof: an admin of another organization cannot be registered as the actor', ok);
  -- (c) browsers (authenticated) cannot call the trusted functions at all
  ok := false; PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN PERFORM register_user_account_audit_context_v1(aa, oa, 'req-spoof-3', 'user_management', ARRAY[c]); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('anti-spoof: authenticated users cannot register an audit context', ok);
  ok := false; PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN PERFORM record_user_account_audit_event_v1(oa, c, ab, 'admin_password_reset', 'password_reset', 'x'); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('anti-spoof: authenticated users cannot write events with an arbitrary actor_user_id', ok);
  -- (d) Admin A's still-live context for K must not be usable by Admin B
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-spoof-4', 'user_management', ARRAY[c]);
  RESET ROLE; PERFORM zz_clear();
  -- another signed-in user (K) edits C's profile while Admin A's context for C is still live
  PERFORM zz_as(k, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE profiles SET name = 'Self Edit' WHERE user_id = c;
  RESET ROLE;
  e := zz_last(c, 'profile_updated', 'name');
  PERFORM zz_check('anti-spoof: a live context registered by Admin A is NOT inherited by another signed-in user (actor is the JWT subject)',
    e IS NOT NULL AND (e ->> 'actor_user_id')::uuid = k AND e ->> 'request_id' LIKE 'tx:%');
  PERFORM zz_check('no authenticated function accepts an actor parameter',
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname IN ('register_my_account_audit_context_v1','get_user_identity_history_summary_v1','record_account_identity_change_confirmation_v1','user_identity_timeline_v1')
                   AND pg_get_function_arguments(p.oid) ~* 'actor'));
END $$;

-- ------------------------------------------------------------------ 10. isolation: RLS on reads, no writes, immutability
DO $$
DECLARE oa uuid := zz_get('orgA'); ob uuid := zz_get('orgB'); aa uuid := zz_get('adminA'); ab uuid := zz_get('adminB'); k uuid := zz_get('K'); c uuid := zz_get('cashier');
        n bigint; ok boolean; n2 bigint;
BEGIN
  SELECT count(*) INTO n2 FROM user_account_audit_events WHERE organization_id = oa;
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM user_account_audit_events WHERE organization_id = oa;
  RESET ROLE;
  PERFORM zz_check('org admin can read own organization audit events', n = n2 AND n > 20);

  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM user_account_audit_events WHERE organization_id = ob OR target_user_id = ab;
  RESET ROLE;
  PERFORM zz_check('CROSS-ORG READ BLOCKED: admin A sees nothing of org B', n = 0);

  PERFORM zz_as(ab, 'authenticated'); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM user_account_audit_events WHERE target_user_id = k;
  RESET ROLE;
  PERFORM zz_check('CROSS-ORG READ BLOCKED: admin B cannot read org A user history even by UUID', n = 0);

  PERFORM zz_as(ab, 'authenticated'); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM user_identity_timeline_v1(oa, k, 100);
  SELECT count(*) INTO n2 FROM user_identity_timeline_v1(NULL, k, 100);
  RESET ROLE;
  PERFORM zz_check('CROSS-ORG READ BLOCKED: timeline function returns nothing to another org (also with a NULL org filter)', n = 0 AND n2 = 0);

  ok := false; PERFORM zz_as(ab, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN PERFORM get_user_identity_history_summary_v1(oa, k); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('CROSS-ORG: history summary refused for another organization', ok);
  ok := false; PERFORM zz_as(ab, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN PERFORM record_account_identity_change_confirmation_v1(oa, k, 'x', 'x@example.test'); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('CROSS-ORG INSERT BLOCKED: identity confirmation refused for another organization', ok);

  PERFORM zz_as(c, 'authenticated'); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM user_account_audit_events;
  RESET ROLE;
  PERFORM zz_check('employees/cashiers cannot browse any audit history', n = 0);

  ok := false; PERFORM zz_as(NULL, 'anon'); SET LOCAL ROLE anon;
  BEGIN PERFORM count(*) FROM user_account_audit_events; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('anon has no access to audit events', ok);

  ok := false; PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN INSERT INTO user_account_audit_events (organization_id, target_user_id, actor_type, event_type, source) VALUES (oa, k, 'user', 'profile_updated', 'user_management');
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('direct INSERT by an admin is blocked (no frontend-forged events)', ok);
  ok := false; PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN INSERT INTO user_account_audit_events (organization_id, target_user_id, actor_type, event_type, source) VALUES (ob, ab, 'user', 'profile_updated', 'user_management');
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('CROSS-ORG INSERT BLOCKED: cannot forge an event into another organization', ok);

  ok := false; PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN UPDATE user_account_audit_events SET new_value = '"x"' WHERE target_user_id = k; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('AUDIT UPDATE BLOCKED for admins', ok);
  ok := false; PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN DELETE FROM user_account_audit_events WHERE target_user_id = k; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('AUDIT DELETE BLOCKED for admins', ok);
  ok := false; PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  BEGIN UPDATE user_account_audit_events SET new_value = '"x"'; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('AUDIT UPDATE BLOCKED for service_role', ok);
  ok := false; PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  BEGIN DELETE FROM user_account_audit_events; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('AUDIT DELETE BLOCKED for service_role', ok);

  ok := false; BEGIN UPDATE user_account_audit_events SET new_value = '"x"'; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  PERFORM zz_check('AUDIT UPDATE BLOCKED even for the owner/superuser (append-only trigger)', ok);
  ok := false; BEGIN DELETE FROM user_account_audit_events; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  PERFORM zz_check('AUDIT DELETE BLOCKED even for the owner/superuser (append-only trigger)', ok);
  ok := false; BEGIN TRUNCATE user_account_audit_events; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  PERFORM zz_check('AUDIT TRUNCATE BLOCKED even for the owner/superuser', ok);

  ok := false; PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  BEGIN UPDATE account_audit_events SET reason = 'tampered'; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('legacy account_audit_events is no longer editable by app roles', ok);

  ok := false; BEGIN INSERT INTO user_account_audit_events (target_user_id, actor_type, event_type, source) VALUES (k, 'user', 'made_up_event', 'user_management'); EXCEPTION WHEN check_violation THEN ok := true; END;
  PERFORM zz_check('event types are a closed list (CHECK constraint)', ok);
END $$;

-- 10b. PostgREST calls RPCs with NAMED arguments; the edge helper sends exactly this set
DO $$
DECLARE oa uuid := zz_get('orgA'); aa uuid := zz_get('adminA'); k uuid := zz_get('K'); ok boolean := true; e jsonb;
BEGIN
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  BEGIN
    PERFORM register_user_account_audit_context_v1(p_actor_user_id => aa, p_organization_id => oa, p_request_id => 'req-named-1', p_source => 'user_management',
      p_target_user_ids => ARRAY[k], p_target_email => NULL, p_batch_id => NULL, p_scope => 'target', p_ttl_seconds => 120, p_method => NULL);
    PERFORM record_user_account_audit_event_v1(p_organization_id => oa, p_target_user_id => k, p_actor_user_id => aa, p_event_type => 'email_change_failed',
      p_source => 'user_management', p_request_id => 'req-named-1', p_metadata => jsonb_build_object('reason', 'timeout'), p_batch_id => NULL);
    PERFORM clear_user_account_audit_context_v1(p_request_id => 'req-named-1');
  EXCEPTION WHEN OTHERS THEN ok := false; RAISE NOTICE 'named-arg call failed: %', SQLERRM; END;
  RESET ROLE; PERFORM zz_clear();
  PERFORM zz_check('edge helper argument names/shape work as named-argument RPC calls', ok);
  e := zz_last(k, 'email_change_failed');
  PERFORM zz_check('named-argument event stored with the human actor and request id', (e ->> 'actor_user_id')::uuid = aa AND e ->> 'request_id' = 'req-named-1');
END $$;

-- ------------------------------------------------------------------ 11. identity timeline reconstructs the whole story, in order, with the identity at each moment
DO $$
DECLARE oa uuid := zz_get('orgA'); aa uuid := zz_get('adminA'); k uuid := zz_get('K'); n int; first_name text; last_ident text; ordered boolean; has_email boolean; has_name boolean;
BEGIN
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  SELECT count(*), bool_and(true) INTO n, ordered FROM user_identity_timeline_v1(oa, k, 500);
  SELECT identity_name INTO first_name FROM user_identity_timeline_v1(oa, k, 500) ORDER BY occurred_at ASC LIMIT 1;
  SELECT (SELECT bool_and(occurred_at >= lag_t) FROM (SELECT occurred_at, COALESCE(lag(occurred_at) OVER (ORDER BY occurred_at, event_id), occurred_at) AS lag_t FROM user_identity_timeline_v1(oa, k, 500)) q) INTO ordered;
  SELECT bool_or(summary ~ 'Email changed: krish-test@example.test → dakshit-test@example.test') INTO has_email FROM user_identity_timeline_v1(oa, k, 500);
  SELECT bool_or(summary ~ 'name changed: Krish Test → Dakshit Prajapati') INTO has_name FROM user_identity_timeline_v1(oa, k, 500);
  SELECT identity_name INTO last_ident FROM user_identity_timeline_v1(oa, k, 500) WHERE event_type = 'account_identity_changed' LIMIT 1;
  RESET ROLE;
  PERFORM zz_check('timeline: rich history reconstructed (>= 20 events for the test account)', n >= 20);
  PERFORM zz_check('timeline: chronological order', ordered);
  PERFORM zz_check('timeline: first row shows the ORIGINAL identity "Krish Test"', first_name = 'Krish Test');
  PERFORM zz_check('timeline: human-readable email change line', has_email);
  PERFORM zz_check('timeline: human-readable name change line', has_name);
  PERFORM zz_check('timeline: later rows carry the identity as it was then (rename visible)', last_ident = 'Dakshit Prajapati');
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  SELECT bool_or(summary = 'Password changed' AND old_value IS NULL AND new_value IS NULL), bool_or(summary = 'Password reset by administrator')
    INTO has_email, has_name FROM user_identity_timeline_v1(oa, k, 500);
  RESET ROLE;
  PERFORM zz_check('timeline: password events read "Password changed" / admin reset, with no value columns', COALESCE(has_email, false) AND COALESCE(has_name, false));
END $$;

-- ------------------------------------------------------------------ 12. deletion, failure isolation, legacy writes, explicit failure events, indexes
DO $$
DECLARE oa uuid := zz_get('orgA'); aa uuid := zz_get('adminA'); u3 uuid := zz_get('bulkU3'); k uuid := zz_get('K'); e jsonb; ok boolean; nm text; before_n bigint;
BEGIN
  -- user deletion keeps its organization (BEFORE DELETE) and its history
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM register_user_account_audit_context_v1(aa, oa, 'req-del-1', 'user_management', ARRAY[u3]);
  DELETE FROM auth.users WHERE id = u3;
  RESET ROLE; PERFORM zz_clear();
  e := zz_last(u3, 'user_deleted');
  PERFORM zz_check('delete user: audited with the real actor and the organization', e IS NOT NULL AND (e ->> 'actor_user_id')::uuid = aa AND (e ->> 'organization_id')::uuid = oa);
  PERFORM zz_check('delete user: earlier history of the deleted account survives', EXISTS (SELECT 1 FROM user_account_audit_events WHERE target_user_id = u3 AND event_type = 'user_created'));

  -- direct legacy user_roles write (depth 1) IS reported
  PERFORM zz_as(aa, 'authenticated'); SET LOCAL ROLE authenticated;
  UPDATE user_roles SET role = 'cashier' WHERE user_id = k;
  RESET ROLE;
  PERFORM zz_check('direct user_roles write is audited (legacy path)', zz_last(k, 'legacy_role_changed') IS NOT NULL AND (zz_last(k, 'legacy_role_changed') ->> 'actor_user_id')::uuid = aa);

  -- explicit failure / denial events (safe reason only)
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM record_user_account_audit_event_v1(oa, k, aa, 'email_change_failed', 'user_management', 'req-fail-1', jsonb_build_object('reason', 'email_already_registered'));
  PERFORM record_user_account_audit_event_v1(oa, k, aa, 'account_change_denied', 'admin_edge_function', 'req-fail-2', jsonb_build_object('requested_action', 'email_change', 'reason', 'different_organization'));
  RESET ROLE; PERFORM zz_clear();
  PERFORM zz_check('failure event recorded with safe reason category', zz_last(k, 'email_change_failed') -> 'metadata' ->> 'reason' = 'email_already_registered');
  PERFORM zz_check('denial event recorded', zz_last(k, 'account_change_denied') -> 'metadata' ->> 'requested_action' = 'email_change');
  -- a denied attempt that names a user of ANOTHER organization must not copy that person's identity into this organization's history
  PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  PERFORM record_user_account_audit_event_v1(oa, zz_get('adminB'), aa, 'account_change_denied', 'admin_edge_function', 'req-foreign-1', jsonb_build_object('requested_action', 'email_change', 'reason', 'different_organization'));
  RESET ROLE; PERFORM zz_clear();
  e := zz_last(zz_get('adminB'), 'account_change_denied');
  PERFORM zz_check('cross-org denial: filed under the CALLER''s organization', (e ->> 'organization_id')::uuid = oa AND (e ->> 'actor_user_id')::uuid = aa);
  PERFORM zz_check('cross-org denial: the foreign target''s name / e-mail / employee id are NOT copied into the row',
    e -> 'target_snapshot' ->> 'name' IS NULL AND e -> 'target_snapshot' ->> 'email' IS NULL AND (e -> 'target_snapshot' ->> 'target_not_in_organization')::boolean);
  PERFORM zz_check('cross-org denial: org A admin cannot learn org B user''s identity from the audit table',
    NOT EXISTS (SELECT 1 FROM user_account_audit_events x WHERE x.organization_id = oa AND x.target_user_id = zz_get('adminB') AND x.target_snapshot::text ~* 'admin-b@example.test|Admin B'));
  PERFORM zz_check('in-org targets still carry their snapshot (control)', zz_last(k, 'email_change_failed') -> 'target_snapshot' ->> 'name' IS NOT NULL);
  ok := false; PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  BEGIN PERFORM record_user_account_audit_event_v1(oa, k, gen_random_uuid(), 'email_change_failed', 'user_management', 'req-fail-3'); EXCEPTION WHEN OTHERS THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('explicit events with an unknown actor id are refused', ok);
  ok := false; PERFORM zz_as(NULL, 'service_role'); SET LOCAL ROLE service_role;
  BEGIN PERFORM record_user_account_audit_event_v1(oa, k, aa, 'role_changed', 'user_management', 'req-fail-4'); EXCEPTION WHEN OTHERS THEN ok := true; END;
  RESET ROLE; PERFORM zz_check('trigger-owned event types cannot be forged through the explicit RPC', ok);
END $$;

-- audit failure policy: business writes roll back; authentication is never blocked
DO $$
DECLARE k uuid := zz_get('K'); ok boolean := true;
BEGIN
  ALTER TABLE public.user_account_audit_events RENAME TO user_account_audit_events_broken;  -- simulate an audit-table outage
  BEGIN UPDATE profiles SET name = 'Should Roll Back' WHERE user_id = k; ok := false; EXCEPTION WHEN OTHERS THEN ok := true; END;
  PERFORM zz_check('audit insert failure ABORTS the profile change (no unaudited business mutation)', ok);
  ok := false;
  BEGIN UPDATE auth.users SET encrypted_password = 'x' || md5(random()::text) WHERE id = k; ok := true; EXCEPTION WHEN OTHERS THEN ok := false; END;
  PERFORM zz_check('audit failure on auth.users NEVER blocks authentication-side writes', ok);
  ALTER TABLE public.user_account_audit_events_broken RENAME TO user_account_audit_events;
END $$;

DO $$
DECLARE k uuid := zz_get('K'); n int;
BEGIN
  PERFORM zz_check('rolled-back failure test left the profile name intact', (SELECT name FROM profiles WHERE user_id = k) = 'Dakshit Prajapati');
  SELECT count(*) INTO n FROM pg_indexes WHERE tablename = 'user_account_audit_events' AND indexname IN
    ('idx_uaa_org_created','idx_uaa_target_created','idx_uaa_actor_created','idx_uaa_type_created','idx_uaa_request');
  PERFORM zz_check('indexes for org/target/actor/event/request present', n = 5);
  PERFORM zz_check('RLS enabled on both audit tables', (SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('user_account_audit_events', 'user_account_audit_context')));
  PERFORM zz_check('no API role holds INSERT/UPDATE/DELETE on the audit table',
    NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_name = 'user_account_audit_events' AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC') AND privilege_type <> 'SELECT'));
  PERFORM zz_check('context table is not readable by API roles',
    NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_name = 'user_account_audit_context' AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')));
  PERFORM zz_check('trigger functions are not executable by API roles',
    NOT has_function_privilege('authenticated', 'public._uaa_emit(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb,text)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public._uaa_emit(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb,text)', 'EXECUTE'));
END $$;

SELECT 'RESULT total=' || count(*) || ' passed=' || count(*) FILTER (WHERE ok) || ' failed=' || count(*) FILTER (WHERE NOT ok) AS summary FROM public.zz_results;
SELECT 'FAILED: ' || name FROM public.zz_results WHERE NOT ok ORDER BY n;
