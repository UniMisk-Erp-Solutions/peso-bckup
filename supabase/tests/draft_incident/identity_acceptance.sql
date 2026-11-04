-- DOC-148 part 2: server-side submission identity. Throwaway database only.
-- Load order: acceptance_schema.sql, integrity_issues_live_fn.sql,
--   20261025100000_stranded_draft_submit_flow_v1.sql, 20261026100000_server_side_submission_identity_v1.sql,
--   then this file. Ends with an intentional ROLLBACK_TEST_DONE error.

CREATE OR REPLACE FUNCTION pg_temp.imp(u uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $f$;
CREATE OR REPLACE FUNCTION pg_temp.rep(label text, pass boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN RAISE NOTICE 'TEST % : % %', rpad(label, 66), CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END, detail; END $f$;

DO $t$
DECLARE
  org uuid := gen_random_uuid(); org2 uuid := gen_random_uuid();
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  k uuid := gen_random_uuid(); kb uuid := gen_random_uuid();
  f jsonb := '{"title":"Taxi","destination":"Mumbai","trip_start":"2026-10-10","trip_end":"2026-10-10","category":"Travel","total_amount":120}';
  r1 jsonb; r2 jsonb; r3 jsonb; b1 jsonb; b2 jsonb; id1 uuid; n int; failed boolean; legacy uuid;
BEGIN
  INSERT INTO organization_memberships (user_id, organization_id, is_active, role) VALUES (u1, org, true, 'employee'), (u2, org, true, 'employee'), (u1, org2, true, 'employee'), (u3, org2, true, 'cashier');

  -- 1 first create
  PERFORM pg_temp.imp(u1); r1 := public.resolve_or_create_expense_v1(org, k, f); RESET ROLE;
  id1 := (r1->>'expense_id')::uuid;
  PERFORM pg_temp.rep('1 first call creates exactly one draft', (r1->>'created')::boolean AND r1->>'status' = 'draft' AND (SELECT count(*) FROM expenses) = 1);

  -- 2 replay (no local state needed): same id, no new row
  PERFORM pg_temp.imp(u1); r2 := public.resolve_or_create_expense_v1(org, k, f); RESET ROLE;
  PERFORM pg_temp.rep('2 replay with the same id returns the SAME row', (r2->>'expense_id')::uuid = id1 AND NOT (r2->>'created')::boolean AND (r2->>'idempotent_replay')::boolean AND (SELECT count(*) FROM expenses) = 1);

  -- 3 replay refreshes draft fields (edit while retrying), same id
  PERFORM pg_temp.imp(u1); r3 := public.resolve_or_create_expense_v1(org, k, f || '{"title":"Taxi 2","total_amount":150}'::jsonb); RESET ROLE;
  PERFORM pg_temp.rep('3 replay refreshes the draft in place', (r3->>'expense_id')::uuid = id1 AND (SELECT title FROM expenses WHERE id = id1) = 'Taxi 2' AND (SELECT total_amount FROM expenses WHERE id = id1) = 150);

  -- 4 audit: one expense_created across all calls
  PERFORM pg_temp.rep('4 exactly one expense_created audit row across create+replays', (SELECT count(*) FROM audit_logs WHERE expense_id = id1 AND action = 'expense_created') = 1);

  -- 5 already-submitted replay: same id, status submitted, row NOT modified, nothing re-created
  UPDATE expenses SET status = 'submitted', title = 'committed' WHERE id = id1;
  PERFORM pg_temp.imp(u1); r2 := public.resolve_or_create_expense_v1(org, k, f); RESET ROLE;
  PERFORM pg_temp.rep('5 already-submitted replay: same id, status submitted, untouched',
    (r2->>'expense_id')::uuid = id1 AND r2->>'status' = 'submitted' AND (r2->>'idempotent_replay')::boolean
    AND (SELECT title FROM expenses WHERE id = id1) = 'committed' AND (SELECT count(*) FROM expenses) = 1);
  UPDATE expenses SET status = 'draft', title = 'Taxi 2' WHERE id = id1;

  -- 6 another USER with the same logical id gets their own row and cannot see/reuse u1's
  PERFORM pg_temp.imp(u2); r2 := public.resolve_or_create_expense_v1(org, k, f); RESET ROLE;
  PERFORM pg_temp.rep('6 same id, different user => different row (isolation)', (r2->>'expense_id')::uuid <> id1 AND (r2->>'created')::boolean);

  -- 7 another ORG (same user) with the same logical id gets its own row
  PERFORM pg_temp.imp(u1); r2 := public.resolve_or_create_expense_v1(org2, k, f); RESET ROLE;
  PERFORM pg_temp.rep('7 same id, different organization => different row', (r2->>'expense_id')::uuid <> id1 AND (r2->>'created')::boolean);

  -- 8 non-member refused; cashier without setting refused; anon has no EXECUTE
  failed := false; PERFORM pg_temp.imp(u2);
  BEGIN PERFORM public.resolve_or_create_expense_v1(org2, gen_random_uuid(), f); EXCEPTION WHEN insufficient_privilege THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('8a non-member of the org is refused', failed);
  failed := false; PERFORM pg_temp.imp(u3);
  BEGIN PERFORM public.resolve_or_create_expense_v1(org2, gen_random_uuid(), f); EXCEPTION WHEN insufficient_privilege THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('8b cashier without allow_cashier_expense_submission is refused', failed);
  PERFORM pg_temp.rep('8c anon has no EXECUTE on the three new RPCs',
    NOT has_function_privilege('anon', 'public.resolve_or_create_expense_v1(uuid,uuid,jsonb,uuid,integer,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.resolve_or_create_expense_batch_v1(uuid,uuid,text,text,date,numeric)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.claim_client_submission_id_v1(uuid,uuid)', 'EXECUTE'));

  -- 9 sensitive fields cannot be passed
  failed := false; PERFORM pg_temp.imp(u1);
  BEGIN PERFORM public.resolve_or_create_expense_v1(org, gen_random_uuid(), f || '{"status":"approved"}'::jsonb); EXCEPTION WHEN insufficient_privilege THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('9 status/user/org/approval fields are refused', failed);

  -- 10 batch parent: same client_batch_id twice => ONE batch
  PERFORM pg_temp.imp(u1);
  b1 := public.resolve_or_create_expense_batch_v1(org, kb, 'L', 'Travel', '2026-10-10', 0);
  b2 := public.resolve_or_create_expense_batch_v1(org, kb, 'L', 'Travel', '2026-10-10', 0); RESET ROLE;
  PERFORM pg_temp.rep('10 duplicate batch request resolves to the same batch', b1->>'batch_id' = b2->>'batch_id' AND (b1->>'created')::boolean AND NOT (b2->>'created')::boolean
    AND (SELECT count(*) FROM expense_batches WHERE client_batch_id = kb) = 1);

  -- 11 batch lines: stable per-line identity; link done by the same call
  PERFORM pg_temp.imp(u1);
  FOR n IN 0..9 LOOP
    PERFORM public.resolve_or_create_expense_v1(org, NULL, f, kb, n, (b1->>'batch_id')::uuid);
  END LOOP;
  -- "retry after restart": every line again, in a different order, plus line 5 refreshed
  FOR n IN REVERSE 9..0 LOOP
    PERFORM public.resolve_or_create_expense_v1(org, NULL, f || '{"title":"retry"}'::jsonb, kb, n, (b1->>'batch_id')::uuid);
  END LOOP;
  RESET ROLE;
  PERFORM pg_temp.rep('11a 10 lines, retried after a restart => still exactly 10 child rows', (SELECT count(*) FROM expenses WHERE batch_id = (b1->>'batch_id')::uuid) = 10);
  PERFORM pg_temp.rep('11b every child is linked to the batch and was refreshed in place', (SELECT count(*) FROM expenses WHERE batch_id = (b1->>'batch_id')::uuid AND title = 'retry') = 10);
  PERFORM pg_temp.rep('11c one expense_created audit row per line (no duplicates)', (SELECT count(*) FROM audit_logs a JOIN expenses e ON e.id = a.expense_id WHERE e.batch_id = (b1->>'batch_id')::uuid AND a.action = 'expense_created') = 10);

  -- 12 wrong mode combinations are refused
  failed := false; PERFORM pg_temp.imp(u1);
  BEGIN PERFORM public.resolve_or_create_expense_v1(org, k, f, kb, 1, NULL); EXCEPTION WHEN invalid_parameter_value THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('12a submission id AND batch line together is refused', failed);
  failed := false; PERFORM pg_temp.imp(u1);
  BEGIN PERFORM public.resolve_or_create_expense_v1(org, NULL, f); EXCEPTION WHEN invalid_parameter_value THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('12b no identity at all is refused', failed);

  -- 13 legacy draft without an id: claimed only on continue, never overwritten, no similarity inference
  INSERT INTO expenses (user_id, organization_id, status, title, destination, trip_start, trip_end, category, total_amount)
    VALUES (u1, org, 'draft', 'legacy', 'x', current_date, current_date, 'Travel', 5) RETURNING id INTO legacy;
  PERFORM pg_temp.imp(u1);
  r1 := public.claim_client_submission_id_v1(legacy, gen_random_uuid());
  r2 := public.claim_client_submission_id_v1(legacy, gen_random_uuid()); RESET ROLE;
  PERFORM pg_temp.rep('13a legacy draft gets an id once; a second claim does not overwrite it', (r1->>'assigned')::boolean AND NOT (r2->>'assigned')::boolean AND r1->>'client_submission_id' = r2->>'client_submission_id');
  failed := false; PERFORM pg_temp.imp(u2);
  BEGIN PERFORM public.claim_client_submission_id_v1(legacy, gen_random_uuid()); EXCEPTION WHEN OTHERS THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('13b another user cannot claim an id on my expense', failed);
  PERFORM pg_temp.rep('13c claiming touched no other row (no backfill)', (SELECT count(*) FROM expenses WHERE client_submission_id IS NULL AND id = legacy) = 0
    AND (SELECT count(*) FROM expenses WHERE user_id = u1 AND organization_id = org AND client_submission_id IS NULL) = 0);

  -- 14 recycle bin flag: a trashed row is reported, never silently resurrected or duplicated
  UPDATE expenses SET deleted_at = now() WHERE id = id1;
  PERFORM pg_temp.imp(u1); r2 := public.resolve_or_create_expense_v1(org, k, f); RESET ROLE;
  PERFORM pg_temp.rep('14 trashed row is reported (in_recycle_bin) and no second row is made', (r2->>'in_recycle_bin')::boolean AND (r2->>'expense_id')::uuid = id1);

  -- 15 DB uniqueness is the real guard: a raw duplicate insert is rejected
  failed := false;
  BEGIN
    INSERT INTO expenses (user_id, organization_id, client_submission_id, status, title, destination, trip_start, trip_end)
    VALUES (u1, org, k, 'draft', 'dup', 'x', current_date, current_date);
  EXCEPTION WHEN unique_violation THEN failed := true; END;
  PERFORM pg_temp.rep('15 raw duplicate (org,user,client_submission_id) violates the unique index', failed);

  RAISE EXCEPTION 'ROLLBACK_TEST_DONE';
END $t$;
