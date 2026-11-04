-- DOC-148 acceptance test (throwaway database ONLY). Order:
--   acceptance.sql (this file: minimal schema + live policy set + live validator fixture is loaded first)
-- Run:  psql -f integrity_issues_live_fn.sql happens INSIDE this file via \i is not used; the runner
-- loads: schema (this file part 1) -> integrity_issues_live_fn.sql -> migration -> this file part 2.
-- Simplest: use run_acceptance.sh-style sequence documented in DOC-148:
--   psql -f acceptance_schema.sql -f integrity_issues_live_fn.sql -f ../../migrations/20261025100000_stranded_draft_submit_flow_v1.sql -f acceptance.sql
-- This file is part 2 (the assertions).

CREATE OR REPLACE FUNCTION pg_temp.imp(u uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $f$;
CREATE OR REPLACE FUNCTION pg_temp.rep(label text, pass boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN RAISE NOTICE 'TEST % : % %', rpad(label, 64), CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END, detail; END $f$;

DO $t$
DECLARE
  org uuid := gen_random_uuid(); org2 uuid := gen_random_uuid();
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  tpl uuid := gen_random_uuid(); cat uuid := gen_random_uuid();
  d1 uuid; d2 uuid; b1 uuid; b2 uuid; b3 uuid; r jsonb; failed boolean; n int; st text;
BEGIN
  INSERT INTO organization_memberships VALUES (u1, org, true), (u2, org, true), (u3, org2, true);
  INSERT INTO expense_categories (id, organization_id, name) VALUES (cat, org, 'Travel');
  INSERT INTO expense_form_field_templates (id, name, field_type, required, show_on_submit) VALUES (tpl, 'Project Unique ID', 'text', true, true);
  INSERT INTO expense_category_form_fields (category_id, organization_id, template_id, required, show_on_submit) VALUES (cat, org, tpl, true, true);
  INSERT INTO expenses (user_id, organization_id, status, title, destination, trip_start, trip_end, category, total_amount)
    VALUES (u1, org, 'draft', 'mine', 'x', current_date, current_date, 'Travel', 10) RETURNING id INTO d1;
  INSERT INTO expenses (user_id, organization_id, status, title, destination, trip_start, trip_end, category, total_amount)
    VALUES (u2, org, 'draft', 'theirs', 'x', current_date, current_date, 'Travel', 10) RETURNING id INTO d2;
  INSERT INTO expense_batches (user_id, organization_id, line_count, total_amount) VALUES (u1, org, 0, 0) RETURNING id INTO b1;
  INSERT INTO expense_batches (user_id, organization_id, line_count, total_amount) VALUES (u2, org, 0, 0) RETURNING id INTO b2;
  INSERT INTO expense_batches (user_id, organization_id, line_count, total_amount) VALUES (u3, org2, 0, 0) RETURNING id INTO b3;

  -- 1 owner draft -> draft update works (whitelisted columns), status stays draft, id unchanged
  PERFORM pg_temp.imp(u1);
  r := public.update_own_draft_expense_v1(d1, '{"title":"edited","total_amount":42.5,"purpose":null}'::jsonb);
  RESET ROLE;
  PERFORM pg_temp.rep('1a owner edits own draft (draft->draft)', r->>'title' = 'edited' AND (r->>'total_amount')::numeric = 42.5 AND r->>'status' = 'draft' AND r->>'id' = d1::text);

  -- 2 cannot edit someone else's draft
  failed := false; PERFORM pg_temp.imp(u1);
  BEGIN PERFORM public.update_own_draft_expense_v1(d2, '{"title":"hijack"}'::jsonb); EXCEPTION WHEN insufficient_privilege THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('2 cannot edit another user''s draft', failed);

  -- 3 cannot change org / user / status / batch / tx number / approval columns
  FOREACH st IN ARRAY ARRAY['organization_id','user_id','status','batch_id','transaction_number','approval_tier','assigned_reviewer_id','approved_by'] LOOP
    failed := false; PERFORM pg_temp.imp(u1);
    BEGIN PERFORM public.update_own_draft_expense_v1(d1, jsonb_build_object(st, 'x')); EXCEPTION WHEN insufficient_privilege THEN failed := true; END; RESET ROLE;
    PERFORM pg_temp.rep('3 sensitive column "' || st || '" is refused', failed);
  END LOOP;

  -- 4 submitted expense cannot be edited through the draft RPC
  UPDATE expenses SET status = 'submitted' WHERE id = d2;
  failed := false; PERFORM pg_temp.imp(u2);
  BEGIN PERFORM public.update_own_draft_expense_v1(d2, '{"title":"x"}'::jsonb); EXCEPTION WHEN OTHERS THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('4 non-draft refused', failed);
  UPDATE expenses SET status = 'draft' WHERE id = d2;

  -- 5 batch link: owner links own draft to own batch (idempotent), others refused
  PERFORM pg_temp.imp(u1); r := public.link_expense_to_batch_v1(d1, b1); r := public.link_expense_to_batch_v1(d1, b1); RESET ROLE;
  SELECT count(*) INTO n FROM expenses WHERE id = d1 AND batch_id = b1;
  PERFORM pg_temp.rep('5a link own draft to own batch (twice = no-op)', n = 1);
  failed := false; PERFORM pg_temp.imp(u1);
  BEGIN PERFORM public.link_expense_to_batch_v1(d1, b2); EXCEPTION WHEN OTHERS THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('5b cannot link to another user''s batch / move between batches', failed);
  failed := false; PERFORM pg_temp.imp(u1);
  BEGIN PERFORM public.link_expense_to_batch_v1(d2, b1); EXCEPTION WHEN insufficient_privilege THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('5c cannot link someone else''s expense', failed);
  failed := false; PERFORM pg_temp.imp(u1);
  BEGIN PERFORM public.link_expense_to_batch_v1(d1, b3); EXCEPTION WHEN OTHERS THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('5d cross-org batch refused', failed);

  -- 6 preflight: missing required field -> not ok, and NOTHING persisted
  SELECT count(*) INTO n FROM expenses;
  PERFORM pg_temp.imp(u1); r := public.preflight_expense_submission_v1(org, 'Travel', '[]'::jsonb); RESET ROLE;
  PERFORM pg_temp.rep('6a preflight reports the missing required field',
    NOT (r->>'ok')::boolean AND r->'issues'->0->>'label' = 'Project Unique ID', r::text);
  PERFORM pg_temp.rep('6b preflight persisted nothing (expenses + values unchanged)',
    (SELECT count(*) FROM expenses) = n AND (SELECT count(*) FROM expense_form_field_values) = 0);
  PERFORM pg_temp.imp(u1);
  r := public.preflight_expense_submission_v1(org, 'Travel', jsonb_build_array(jsonb_build_object('template_id', tpl, 'value', 'P-1')));
  RESET ROLE;
  PERFORM pg_temp.rep('6c preflight ok when the field is supplied', (r->>'ok')::boolean AND jsonb_array_length(r->'issues') = 0, r::text);
  PERFORM pg_temp.rep('6d still nothing persisted', (SELECT count(*) FROM expenses) = n AND (SELECT count(*) FROM expense_form_field_values) = 0);

  -- 7 preflight isolation: non-member of the org refused
  failed := false; PERFORM pg_temp.imp(u3);
  BEGIN PERFORM public.preflight_expense_submission_v1(org, 'Travel', '[]'::jsonb); EXCEPTION WHEN insufficient_privilege THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('7 preflight refuses a non-member (cross-org)', failed);

  -- 8 anon cannot execute
  PERFORM pg_temp.rep('8 anon has no EXECUTE on any of the three RPCs',
    NOT has_function_privilege('anon', 'public.update_own_draft_expense_v1(uuid,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.link_expense_to_batch_v1(uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.preflight_expense_submission_v1(uuid,text,jsonb)', 'EXECUTE'));

  -- 9 direct owner UPDATE of a draft stays blocked by RLS (policy unchanged; RPC is the only door)
  failed := false; PERFORM pg_temp.imp(u1);
  BEGIN UPDATE expenses SET title = 'direct' WHERE id = d1; EXCEPTION WHEN insufficient_privilege THEN failed := true; END; RESET ROLE;
  PERFORM pg_temp.rep('9 raw draft->draft UPDATE is still refused by RLS (no policy was loosened)', failed);

  RAISE EXCEPTION 'ROLLBACK_TEST_DONE';
END $t$;
