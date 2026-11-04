CREATE FUNCTION pg_temp.try_fn(sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE sql;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  SET CONSTRAINTS ALL DEFERRED;
  RETURN 'REFUSED: ' || left(SQLERRM, 80);
END $f$;
CREATE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
END $f$;
DO $t$
DECLARE o uuid; adm uuid; emp uuid; thr numeric; r jsonb; r2 jsonb; xid uuid; k uuid := gen_random_uuid(); ks text; other uuid; res text; bulk jsonb; eid text;
BEGIN
  SELECT id INTO o FROM organizations WHERE name='ZZZ QA Backup-Restore Test Org';
  SELECT user_id INTO adm FROM organization_memberships WHERE organization_id=o AND role='admin' AND is_active LIMIT 1;
  SELECT user_id INTO emp FROM organization_memberships WHERE organization_id=o AND role='employee' AND is_active LIMIT 1;
  SELECT attachment_required_above_amount INTO thr FROM organization_settings WHERE organization_id=o;
  SELECT employee_id INTO eid FROM profiles WHERE user_id=emp;
  RAISE NOTICE 'threshold=% admin/emp found=%/% employee_id_present=%', thr, adm IS NOT NULL, emp IS NOT NULL, eid IS NOT NULL;
  PERFORM pg_temp.as_user(adm);
  SET LOCAL ROLE authenticated;

  r := public.admin_submit_expense_for_employee_v3(o, emp, 'zz-adm-1', 'x', current_date, current_date, 'other', thr, NULL, '[]', 'submitted', NULL, 'k-'||gen_random_uuid()::text);
  RAISE NOTICE 'T1 admin amount=threshold no bill -> status=% (expected submitted)', r->>'status';

  res := pg_temp.try_fn(format('SELECT public.admin_submit_expense_for_employee_v3(%L,%L,%L,%L,current_date,current_date,%L,%s,NULL,%L,%L,NULL,%L)', o, emp, 'zz-adm-2','x','other', thr+30, '[]', 'submitted', 'k-'||gen_random_uuid()::text));
  RAISE NOTICE 'T2 admin amount>threshold no bill -> %', res;
  RAISE NOTICE 'T2b rows persisted for zz-adm-2: % (expected 0)', (SELECT count(*) FROM expenses WHERE title='zz-adm-2');

  r := public.admin_prepare_expense_for_employee_v1(o, emp, 'zz-adm-3','x',current_date,current_date,'other', thr+30, NULL, k);
  xid := (r->>'expense_id')::uuid;
  r2 := public.admin_prepare_expense_for_employee_v1(o, emp, 'zz-adm-3','x',current_date,current_date,'other', thr+30, NULL, k);
  RAISE NOTICE 'T3 prepare: status=% replay_same_id=% created/replay=%/%', r->>'status', (r2->>'expense_id')::uuid = xid, r->>'created', r2->>'created';
  ks := 'k-'||k::text;
  res := pg_temp.try_fn(format('SELECT public.admin_submit_expense_for_employee_v3(%L,%L,%L,%L,current_date,current_date,%L,%s,NULL,%L,%L,NULL,%L,%L)', o, emp, 'zz-adm-3','x','other', thr+30, '[]', 'submitted', ks, xid));
  RAISE NOTICE 'T4 promote WITHOUT bill -> %', res;
  RAISE NOTICE 'T4b prepared row status=% ; rows with title=% (expected draft / 1)', (SELECT status FROM expenses WHERE id=xid), (SELECT count(*) FROM expenses WHERE title='zz-adm-3');

  RESET ROLE;
  INSERT INTO attachments (expense_id, organization_id, uploaded_by, file_url, storage_path, filename, content_type, file_size, deleted_at) VALUES (xid,o,adm,'https://x/a.png','zz/a.png','a.png','image/png',1, now());
  SELECT id INTO other FROM expenses WHERE organization_id=o AND id <> xid ORDER BY created_at DESC LIMIT 1;
  INSERT INTO attachments (expense_id, organization_id, uploaded_by, file_url, storage_path, filename, content_type, file_size) VALUES (other,o,adm,'https://x/b.png','zz/b.png','b.png','image/png',1);
  SET LOCAL ROLE authenticated;
  res := pg_temp.try_fn(format('SELECT public.admin_submit_expense_for_employee_v3(%L,%L,%L,%L,current_date,current_date,%L,%s,NULL,%L,%L,NULL,%L,%L)', o, emp, 'zz-adm-3','x','other', thr+30, '[]', 'submitted', ks, xid));
  RAISE NOTICE 'T5 soft-deleted bill + another expense bill -> %', res;

  RESET ROLE;
  INSERT INTO attachments (expense_id, organization_id, uploaded_by, file_url, storage_path, filename, content_type, file_size) VALUES (xid,o,adm,'https://x/c.png','zz/c.png','c.png','image/png',1);
  SET LOCAL ROLE authenticated;
  r := public.admin_submit_expense_for_employee_v3(o, emp, 'zz-adm-3','x',current_date,current_date,'other', thr+30, NULL, '[]', 'submitted', NULL, ks, xid);
  RAISE NOTICE 'T6 promote with bill -> status=% same_id=% replay=%', r->>'status', (r->>'expense_id')::uuid = xid, r->>'idempotent_replay';
  r2 := public.admin_submit_expense_for_employee_v3(o, emp, 'zz-adm-3','x',current_date,current_date,'other', thr+30, NULL, '[]', 'submitted', NULL, ks, xid);
  RAISE NOTICE 'T7 lost-response retry -> same_id=% idempotent_replay=%', (r2->>'expense_id')::uuid = xid, r2->>'idempotent_replay';
  RESET ROLE;
  RAISE NOTICE 'T8 rows=% (1) created_audit=% (1) submitted_audit=% (1) notifications=% attachments_live=% (1)',
    (SELECT count(*) FROM expenses WHERE title='zz-adm-3'),
    (SELECT count(*) FROM audit_logs WHERE expense_id=xid AND action='expense_created'),
    (SELECT count(*) FROM audit_logs WHERE expense_id=xid AND action='expense_submitted'),
    (SELECT count(*) FROM notifications WHERE expense_id=xid),
    (SELECT count(*) FROM attachments WHERE expense_id=xid AND deleted_at IS NULL);

  SET LOCAL ROLE authenticated;
  bulk := public.admin_bulk_submit_expenses_v3(o, jsonb_build_array(
     jsonb_build_object('row_index',1,'email',(SELECT email FROM profiles WHERE user_id=emp),'client_operation_id','b-'||gen_random_uuid(),'title','zz-bulk-ok','destination','x','trip_start',current_date,'trip_end',current_date,'category','other','amount',thr),
     jsonb_build_object('row_index',2,'email',(SELECT email FROM profiles WHERE user_id=emp),'client_operation_id','b-'||gen_random_uuid(),'title','zz-bulk-bad','destination','x','trip_start',current_date,'trip_end',current_date,'category','other','amount',thr+30)));
  RESET ROLE;
  RAISE NOTICE 'T9 bulk: succeeded=% failed=% (expected 1/1) bad-row-error=%', bulk->>'succeeded', bulk->>'failed', left(bulk->'results'->1->>'error', 70);
  RAISE NOTICE 'T9b bulk-bad rows persisted=% (0)', (SELECT count(*) FROM expenses WHERE title='zz-bulk-bad');

  SET LOCAL ROLE authenticated;
  res := pg_temp.try_fn(format('SELECT public.admin_submit_expense_for_employee_v2(%L,%L,%L,%L,current_date,current_date,%L,%s,NULL,%L,%L,NULL,%L)', o, emp, 'zz-adm-old','x','other', thr+30, '[]', 'submitted', 'k-'||gen_random_uuid()::text));
  RESET ROLE;
  RAISE NOTICE 'T10 legacy v2 above threshold -> %', res;
END $t$;
