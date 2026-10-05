\set ON_ERROR_STOP 1
\pset format aligned
\pset border 2
\pset pager off

BEGIN;
\i supabase/migrations/20260909100000_microlink_atomic_submission_v1.sql
\i supabase/migrations/20260909172000_microlink_v1_allow_submitted_edit.sql

\echo ''
\echo '################ ACCEPTANCE TESTS (all inside one rolled-back transaction) ################'

-- the real employee from the 2026-09-08 incident, and a real project
SELECT p.user_id::text AS emp_uid
FROM public.profiles p
WHERE p.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344' AND p.employee_id='6818' \gset

-- an UNAMBIGUOUS project: exactly one legal option for both children
SELECT b.parent_option_value AS uid_value
FROM public.expense_form_field_option_branches b
WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
  AND b.retired_at IS NULL
GROUP BY 1
HAVING count(*) FILTER (WHERE b.field_key='project_id') = 1
   AND count(*) FILTER (WHERE b.field_key='project_name') = 1
   AND bool_and(jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) = 1)
ORDER BY 1 LIMIT 1 \gset

-- an AMBIGUOUS project, for the negative test
SELECT b.parent_option_value AS amb_uid
FROM public.expense_form_field_option_branches b
WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
  AND b.retired_at IS NULL
  AND b.field_key='project_id'
  AND jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) > 1
ORDER BY 1 LIMIT 1 \gset

\echo ''
\echo '--- A. 6818 REPRODUCTION: a complete form, ONE call ---'
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'emp_uid', 'role','authenticated')::text, true) AS x \gset

CREATE TEMP TABLE res AS
SELECT public.submit_microlink_expense_v1(jsonb_build_object(
  'idempotency_key', '11111111-1111-1111-1111-111111111111',
  'core', jsonb_build_object(
     'title','V2 ACCEPTANCE — travelling',
     'destination','Test Site',
     'trip_start','2026-09-09',
     'category','Travelling (Public and Private Transport)',
     'total_amount', 123.45,
     'purpose','atomic submission acceptance test'),
  'microlink', jsonb_build_object(
     'project_unique_id', :'uid_value',
     'from_location','Ahmedabad',
     'to_location','Gandhinagar')
)) AS receipt;

SELECT receipt->>'committed'   AS committed,
       receipt->>'replayed'    AS replayed,
       receipt->>'status'      AS status,
       receipt->>'transaction_number' AS txn,
       receipt->>'revision'    AS revision,
       receipt->>'persisted_custom_fields' AS custom_fields,
       left(receipt->>'snapshot_hash', 12) AS hash
FROM res;

\echo ''
\echo '--- what actually reached the database ---'
SELECT e.transaction_number AS txn, e.status::text AS status, e.total_amount,
       e.category, e.approval_tier AS tier,
       (SELECT count(*) FROM public.expense_form_field_values v WHERE v.expense_id=e.id) AS field_rows,
       (SELECT count(*) FROM public.audit_logs a
         WHERE a.expense_id=e.id AND a.action='expense_submitted') AS submit_events
FROM public.expenses e
WHERE e.id = ((SELECT receipt FROM res)->>'expense_id')::uuid;

SELECT COALESCE(t.name, b.field_key) AS field, v.field_value
FROM public.expense_form_field_values v
LEFT JOIN public.expense_form_field_templates t ON t.id=v.template_id
LEFT JOIN public.expense_form_field_option_branches b ON b.id=v.branch_field_id
WHERE v.expense_id = ((SELECT receipt FROM res)->>'expense_id')::uuid
ORDER BY 1;

\echo ''
\echo '--- B. IDEMPOTENT RETRY: same key must NOT create a second expense ---'
SELECT (SELECT count(*) FROM public.expenses
         WHERE title='V2 ACCEPTANCE — travelling') AS before_retry;

SELECT r->>'replayed' AS replayed,
       (r->>'expense_id') = ((SELECT receipt FROM res)->>'expense_id') AS same_expense,
       (r->>'transaction_number') = ((SELECT receipt FROM res)->>'transaction_number') AS same_number
FROM (SELECT public.submit_microlink_expense_v1(jsonb_build_object(
  'idempotency_key','11111111-1111-1111-1111-111111111111',
  'core', jsonb_build_object('title','V2 ACCEPTANCE — travelling','destination','Test Site',
     'trip_start','2026-09-09','category','Travelling (Public and Private Transport)',
     'total_amount',123.45),
  'microlink', jsonb_build_object('project_unique_id', :'uid_value',
     'from_location','Ahmedabad','to_location','Gandhinagar'))) AS r) q;

SELECT (SELECT count(*) FROM public.expenses
         WHERE title='V2 ACCEPTANCE — travelling') AS after_retry,
       (SELECT count(*) FROM public.audit_logs
         WHERE expense_id=((SELECT receipt FROM res)->>'expense_id')::uuid
           AND action='expense_submitted') AS submit_events_after_retry;

\echo ''
\echo '--- C. TIMEOUT RECONCILIATION: look up the attempt by its key ---'
SELECT public.get_expense_submission_result_v1('11111111-1111-1111-1111-111111111111')
         ->>'committed' AS committed,
       public.get_expense_submission_result_v1('99999999-9999-9999-9999-999999999999')
         ->>'known' AS unknown_key_known;

\echo ''
\echo '--- D. MISSING PROJECT UID: must be REFUSED, with NO partial state ---'
SELECT count(*) AS expenses_before FROM public.expenses
WHERE title='V2 ACCEPTANCE — should not exist';

DO $$
DECLARE r jsonb; n int;
BEGIN
  BEGIN
    r := public.submit_microlink_expense_v1(jsonb_build_object(
      'idempotency_key','22222222-2222-2222-2222-222222222222',
      'core', jsonb_build_object('title','V2 ACCEPTANCE — should not exist',
        'destination','Test Site','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',50),
      'microlink', jsonb_build_object('from_location','A','to_location','B')));
    RAISE NOTICE '  ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 68);
  END;
  SELECT count(*) INTO n FROM public.expenses
   WHERE title='V2 ACCEPTANCE — should not exist';
  RAISE NOTICE '  rows left behind by the refused submit: %  (must be 0)', n;
END $$;

\echo ''
\echo '--- E. INVALID PROJECT UID: refused ---'
DO $$
DECLARE r jsonb;
BEGIN
  r := public.submit_microlink_expense_v1(jsonb_build_object(
    'idempotency_key','33333333-3333-3333-3333-333333333333',
    'core', jsonb_build_object('title','bad uid','destination','X','trip_start','2026-09-09',
      'category','Travelling (Public and Private Transport)','total_amount',10),
    'microlink', jsonb_build_object('project_unique_id','NOT-A-REAL-UID',
      'from_location','A','to_location','B')));
  RAISE NOTICE '  ACCEPTED  <-- WRONG';
EXCEPTION WHEN others THEN
  RAISE NOTICE '  REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 60);
END $$;

\echo ''
\echo '--- E2/E3. AMBIGUOUS PROJECT: refuse without a choice, accept with one ---'
DO $$
DECLARE
  r jsonb; v_amb text; v_pid text; v_pname text;
BEGIN
  SELECT b.parent_option_value INTO v_amb
  FROM public.expense_form_field_option_branches b
  WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
    AND b.retired_at IS NULL AND b.field_key='project_id'
    AND jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) > 1
  ORDER BY 1 LIMIT 1;

  RAISE NOTICE '  ambiguous project under test: %', v_amb;

  -- E2: no choice supplied
  BEGIN
    r := public.submit_microlink_expense_v1(jsonb_build_object(
      'idempotency_key','66666666-6666-6666-6666-666666666666',
      'core', jsonb_build_object('title','ambiguous','destination','X',
        'trip_start','2026-09-09','category','Travelling (Public and Private Transport)',
        'total_amount',10),
      'microlink', jsonb_build_object('project_unique_id', v_amb,
        'from_location','A','to_location','B')));
    RAISE NOTICE '  E2 no choice: ACCEPTED  <-- WRONG, a value was invented';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  E2 no choice: REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 58);
  END;

  -- E3: a valid explicit choice
  SELECT b.options->>0 INTO v_pid FROM public.expense_form_field_option_branches b
  WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND b.parent_option_value=v_amb AND b.field_key='project_id' AND b.retired_at IS NULL;
  SELECT b.options->>0 INTO v_pname FROM public.expense_form_field_option_branches b
  WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND b.parent_option_value=v_amb AND b.field_key='project_name' AND b.retired_at IS NULL;

  BEGIN
    r := public.submit_microlink_expense_v1(jsonb_build_object(
      'idempotency_key','77777777-7777-7777-7777-777777777777',
      'core', jsonb_build_object('title','ambiguous chosen','destination','X',
        'trip_start','2026-09-09','category','Travelling (Public and Private Transport)',
        'total_amount',10),
      'microlink', jsonb_build_object('project_unique_id', v_amb,
        'project_id', v_pid, 'project_name', v_pname,
        'from_location','A','to_location','B')));
    RAISE NOTICE '  E3 with choice: ACCEPTED  txn=%  fields=%',
      r->>'transaction_number', r->>'persisted_custom_fields';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  E3 with choice: REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 58);
  END;

  -- E4: a choice that is NOT one of the legal options
  BEGIN
    r := public.submit_microlink_expense_v1(jsonb_build_object(
      'idempotency_key','88888888-8888-8888-8888-888888888888',
      'core', jsonb_build_object('title','bad choice','destination','X',
        'trip_start','2026-09-09','category','Travelling (Public and Private Transport)',
        'total_amount',10),
      'microlink', jsonb_build_object('project_unique_id', v_amb,
        'project_id','NOT-LEGAL', 'project_name', v_pname,
        'from_location','A','to_location','B')));
    RAISE NOTICE '  E4 illegal choice: ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  E4 illegal choice: REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 52);
  END;

  -- E5: a STALE client value for a deterministic project must be refused,
  --     not silently overwritten.
  BEGIN
    r := public.submit_microlink_expense_v1(jsonb_build_object(
      'idempotency_key','a8888888-8888-8888-8888-888888888888',
      'core', jsonb_build_object('title','stale project id','destination','X',
        'trip_start','2026-09-09','category','Travelling (Public and Private Transport)',
        'total_amount',10),
      'microlink', jsonb_build_object('project_unique_id','199601M1',
        'project_id','9999999', 'from_location','A','to_location','B')));
    RAISE NOTICE '  E5 stale value: ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  E5 stale value: REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 56);
  END;
END $$;

\echo '--- F. WRONG ORGANIZATION: a Mistry And Shah employee must be rejected ---'
SELECT p.user_id::text AS ms_uid FROM public.profiles p
WHERE p.organization_id='e0e9c7a9-555f-448a-8ba2-10fae8e0bf64' AND p.employee_id='2094' \gset
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'ms_uid', 'role','authenticated')::text, true) AS y \gset
DO $$
DECLARE r jsonb;
BEGIN
  r := public.submit_microlink_expense_v1(jsonb_build_object(
    'idempotency_key','44444444-4444-4444-4444-444444444444',
    'core', jsonb_build_object('title','wrong org','trip_start','2026-09-09',
      'category','Food','total_amount',10),
    'microlink', '{}'::jsonb));
  RAISE NOTICE '  ACCEPTED  <-- WRONG';
EXCEPTION WHEN others THEN
  RAISE NOTICE '  REJECTED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 60);
END $$;

\echo ''
\echo '--- G. DRAFT SAVE is atomic too, and may be incomplete ---'
SELECT set_config('request.jwt.claims',
  json_build_object('sub', :'emp_uid', 'role','authenticated')::text, true) AS z \gset
SELECT r->>'status' AS status, r->>'transaction_number' AS txn,
       r->>'persisted_custom_fields' AS custom_fields
FROM (SELECT public.save_microlink_expense_draft_v1(jsonb_build_object(
  'idempotency_key','55555555-5555-5555-5555-555555555555',
  'core', jsonb_build_object('title','V2 draft','destination','Y','trip_start','2026-09-09',
     'category','Travelling (Public and Private Transport)','total_amount',77),
  'microlink', jsonb_build_object('from_location','OnlyFrom'))) AS r) q;

\echo ''
\echo '--- H. BATCH: 2 valid + 1 invalid must submit ZERO ---'
DO $$
DECLARE r jsonb; v_uid text; n_before int; n_after int;
BEGIN
  SELECT b.parent_option_value INTO v_uid
  FROM public.expense_form_field_option_branches b
  WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
    AND b.retired_at IS NULL
  GROUP BY 1
  HAVING count(*) FILTER (WHERE b.field_key='project_id') = 1
     AND count(*) FILTER (WHERE b.field_key='project_name') = 1
     AND bool_and(jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) = 1)
  ORDER BY 1 LIMIT 1;

  SELECT count(*) INTO n_before FROM public.expenses WHERE title LIKE 'V2 BATCH%';

  r := public.submit_microlink_expense_batch_v1(jsonb_build_array(
    jsonb_build_object('idempotency_key', gen_random_uuid()::text,
      'core', jsonb_build_object('title','V2 BATCH ok 1','destination','X',
        'trip_start','2026-09-09','category','Travelling (Public and Private Transport)',
        'total_amount',10),
      'microlink', jsonb_build_object('project_unique_id', v_uid,
        'from_location','A','to_location','B')),
    jsonb_build_object('idempotency_key', gen_random_uuid()::text,
      'core', jsonb_build_object('title','V2 BATCH ok 2','destination','X',
        'trip_start','2026-09-09','category','Travelling (Public and Private Transport)',
        'total_amount',20),
      'microlink', jsonb_build_object('project_unique_id', v_uid,
        'from_location','A','to_location','B')),
    jsonb_build_object('idempotency_key', gen_random_uuid()::text,
      'core', jsonb_build_object('title','V2 BATCH bad','destination','X',
        'trip_start','2026-09-09','category','Travelling (Public and Private Transport)',
        'total_amount',30),
      'microlink', jsonb_build_object('from_location','A','to_location','B'))
  ), false);

  SELECT count(*) INTO n_after FROM public.expenses WHERE title LIKE 'V2 BATCH%';
  RAISE NOTICE '  batch_valid=%  committed=%  submitted_count=%',
    r->>'batch_valid', r->>'committed', r->>'submitted_count';
  RAISE NOTICE '  failed row: %', left((r->'failed'->0)::text, 110);
  RAISE NOTICE '  expenses created: %  (MUST be 0 - all or none)', n_after - n_before;
END $$;

\echo ''
\echo '--- I. BATCH: all valid must submit ALL ---'
DO $$
DECLARE r jsonb; v_uid text; n_before int; n_after int;
BEGIN
  SELECT b.parent_option_value INTO v_uid
  FROM public.expense_form_field_option_branches b
  WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
    AND b.retired_at IS NULL
  GROUP BY 1
  HAVING count(*) FILTER (WHERE b.field_key='project_id') = 1
     AND count(*) FILTER (WHERE b.field_key='project_name') = 1
     AND bool_and(jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) = 1)
  ORDER BY 1 LIMIT 1;

  SELECT count(*) INTO n_before FROM public.expenses WHERE title LIKE 'V2 ALLOK%';
  r := public.submit_microlink_expense_batch_v1(jsonb_build_array(
    jsonb_build_object('idempotency_key', gen_random_uuid()::text,
      'core', jsonb_build_object('title','V2 ALLOK 1','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',11),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')),
    jsonb_build_object('idempotency_key', gen_random_uuid()::text,
      'core', jsonb_build_object('title','V2 ALLOK 2','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',12),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B'))
  ), false);
  SELECT count(*) INTO n_after FROM public.expenses WHERE title LIKE 'V2 ALLOK%';
  RAISE NOTICE '  batch_valid=%  submitted_count=%  expenses created=% (expect 2)',
    r->>'batch_valid', r->>'submitted_count', n_after - n_before;
END $$;

\echo ''
\echo '--- J. OPTIMISTIC CONCURRENCY: a stale expected_revision is refused ---'
DO $$
DECLARE r jsonb; v_id uuid; v_rev bigint; v_uid text;
BEGIN
  SELECT b.parent_option_value INTO v_uid
  FROM public.expense_form_field_option_branches b
  WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
    AND b.retired_at IS NULL
  GROUP BY 1
  HAVING count(*) FILTER (WHERE b.field_key='project_id') = 1
     AND bool_and(jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) = 1)
  ORDER BY 1 LIMIT 1;

  r := public.save_microlink_expense_draft_v1(jsonb_build_object(
    'idempotency_key', gen_random_uuid()::text,
    'core', jsonb_build_object('title','V2 concurrency','destination','X','trip_start','2026-09-09',
      'category','Travelling (Public and Private Transport)','total_amount',5),
    'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
  v_id := (r->>'expense_id')::uuid;

  -- another session edits it
  UPDATE public.expenses SET total_amount = 6 WHERE id = v_id;
  SELECT revision INTO v_rev FROM public.expenses WHERE id = v_id;
  RAISE NOTICE '  revision after another session edited it: % (expect 1)', v_rev;

  BEGIN
    r := public.submit_microlink_expense_v1(jsonb_build_object(
      'idempotency_key', gen_random_uuid()::text,
      'expense_id', v_id::text, 'expected_revision', 0,
      'core', jsonb_build_object('title','V2 concurrency','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',5),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
    RAISE NOTICE '  stale revision: ACCEPTED  <-- WRONG, an edit was overwritten';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  stale revision: REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 58);
  END;

  -- and with the CURRENT revision it goes through
  BEGIN
    r := public.submit_microlink_expense_v1(jsonb_build_object(
      'idempotency_key', gen_random_uuid()::text,
      'expense_id', v_id::text, 'expected_revision', v_rev,
      'core', jsonb_build_object('title','V2 concurrency','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',6),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
    RAISE NOTICE '  current revision: ACCEPTED  txn=%  status=%',
      r->>'transaction_number', r->>'status';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  current revision: REFUSED  <-- WRONG  %', left(SQLERRM, 50);
  END;
END $$;

\echo ''
\echo '--- K. EDIT AN EXISTING DRAFT: one call updates core AND fields AND submits ---'
DO $$
DECLARE r jsonb; v_id uuid; u1 text; u2 text; n int;
BEGIN
  SELECT min(q.x), max(q.x) INTO u1, u2 FROM (
    SELECT b.parent_option_value AS x
    FROM public.expense_form_field_option_branches b
    WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
      AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
      AND b.retired_at IS NULL
    GROUP BY 1
    HAVING count(*) FILTER (WHERE b.field_key='project_id') = 1
       AND count(*) FILTER (WHERE b.field_key='project_name') = 1
       AND bool_and(jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) = 1)
    LIMIT 2) q;

  -- draft on project u1
  r := public.save_microlink_expense_draft_v1(jsonb_build_object(
    'idempotency_key', gen_random_uuid()::text,
    'core', jsonb_build_object('title','V2 edit','destination','X','trip_start','2026-09-09',
      'category','Travelling (Public and Private Transport)','total_amount',9),
    'microlink', jsonb_build_object('project_unique_id', u1,'from_location','A','to_location','B')));
  v_id := (r->>'expense_id')::uuid;
  RAISE NOTICE '  draft on project %: fields=%', u1, r->>'persisted_custom_fields';

  -- employee switches to u2 and submits, in ONE call
  r := public.submit_microlink_expense_v1(jsonb_build_object(
    'idempotency_key', gen_random_uuid()::text,
    'expense_id', v_id::text,
    'core', jsonb_build_object('title','V2 edit switched','destination','Y','trip_start','2026-09-09',
      'category','Travelling (Public and Private Transport)','total_amount',99),
    'microlink', jsonb_build_object('project_unique_id', u2,'from_location','C','to_location','D')));
  RAISE NOTICE '  after switch to %: status=% txn=% fields=%',
    u2, r->>'status', r->>'transaction_number', r->>'persisted_custom_fields';

  -- the OLD project's branch rows must be gone; no stale project data
  SELECT count(*) INTO n
  FROM public.expense_form_field_values v
  JOIN public.expense_form_field_option_branches b ON b.id = v.branch_field_id
  WHERE v.expense_id = v_id AND b.parent_option_value = u1;
  RAISE NOTICE '  stale branch rows left from the old project: % (MUST be 0)', n;

  SELECT count(*) INTO n FROM public.expense_form_field_values v WHERE v.expense_id = v_id;
  RAISE NOTICE '  total field rows now: %', n;
END $$;

\echo ''
\echo '--- L. HOTFIX 2026-09-09: UPDATE an already-SUBMITTED expense IN PLACE ---'
DO $$
DECLARE
  r jsonb; v_id uuid; v_txn text; v_rev bigint; v_uid text;
  v_tier text; v_reviewer uuid; v_engineer uuid;
  n_submitted_before int; n_submitted_after int;
  n_updated_before int; n_updated_after int;
BEGIN
  SELECT b.parent_option_value INTO v_uid
  FROM public.expense_form_field_option_branches b
  WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
    AND b.retired_at IS NULL
  GROUP BY 1
  HAVING count(*) FILTER (WHERE b.field_key='project_id') = 1
     AND count(*) FILTER (WHERE b.field_key='project_name') = 1
     AND bool_and(jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) = 1)
  ORDER BY 1 LIMIT 1;

  -- initial submission (this DOES resolve routing and DOES log expense_submitted)
  r := public.submit_microlink_expense_v1(jsonb_build_object(
    'idempotency_key', gen_random_uuid()::text,
    'core', jsonb_build_object('title','V2 SUBMITTED EDIT','destination','X','trip_start','2026-09-09',
      'category','Travelling (Public and Private Transport)','total_amount',40),
    'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
  v_id  := (r->>'expense_id')::uuid;
  v_txn := r->>'transaction_number';
  v_rev := (r->>'revision')::bigint;
  RAISE NOTICE '  initial submit: status=%  txn=%', r->>'status', v_txn;

  SELECT approval_tier, assigned_reviewer_id, assigned_engineer_id
    INTO v_tier, v_reviewer, v_engineer FROM public.expenses WHERE id = v_id;

  SELECT count(*) INTO n_submitted_before FROM public.audit_logs
   WHERE expense_id = v_id AND action = 'expense_submitted';
  SELECT count(*) INTO n_updated_before FROM public.audit_logs
   WHERE expense_id = v_id AND action = 'expense_updated';

  -- the regression: editing it while it is still 'submitted' via the OLD
  -- submit_microlink_expense_v1 path is refused before this hotfix; via the
  -- NEW dedicated action it must succeed, IN PLACE, with no rerouting.
  BEGIN
    r := public.update_microlink_submitted_expense_v1(jsonb_build_object(
      'idempotency_key', gen_random_uuid()::text,
      'expense_id', v_id::text, 'expected_revision', v_rev,
      'core', jsonb_build_object('title','V2 SUBMITTED EDIT v2','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',41),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
    RAISE NOTICE '  submitted update: ACCEPTED  status=%  txn=%  same_id=%  same_txn=%',
      r->>'status', r->>'transaction_number',
      (r->>'expense_id') = v_id::text, (r->>'transaction_number') = v_txn;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  submitted update: REFUSED  <-- REGRESSION  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 68);
  END;

  -- the OLD submit path must now REFUSE a re-submit of an already-submitted expense
  BEGIN
    r := public.submit_microlink_expense_v1(jsonb_build_object(
      'idempotency_key', gen_random_uuid()::text,
      'expense_id', v_id::text,
      'core', jsonb_build_object('title','V2 SUBMITTED EDIT via submit','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',43),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
    RAISE NOTICE '  submit_v1 on a submitted expense: ACCEPTED  <-- WRONG, submit must not double as edit';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  submit_v1 on a submitted expense: REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 60);
  END;

  RAISE NOTICE '  expenses with this title: %  (MUST be 1, no duplicate)',
    (SELECT count(*) FROM public.expenses WHERE title LIKE 'V2 SUBMITTED EDIT%');

  SELECT approval_tier, assigned_reviewer_id, assigned_engineer_id
    INTO v_tier, v_reviewer, v_engineer FROM public.expenses WHERE id = v_id;
  RAISE NOTICE '  routing after update: tier=%  reviewer=%  engineer=%', v_tier, v_reviewer, v_engineer;

  SELECT count(*) INTO n_submitted_after FROM public.audit_logs
   WHERE expense_id = v_id AND action = 'expense_submitted';
  SELECT count(*) INTO n_updated_after FROM public.audit_logs
   WHERE expense_id = v_id AND action = 'expense_updated';
  RAISE NOTICE '  expense_submitted delta: %  (MUST be 0)', n_submitted_after - n_submitted_before;
  RAISE NOTICE '  expense_updated delta: %  (expected 1)', n_updated_after - n_updated_before;

  -- idempotent retry of the SAME update must not add a second expense_updated row
  DECLARE v_retry_key uuid := gen_random_uuid();
  BEGIN
    r := public.update_microlink_submitted_expense_v1(jsonb_build_object(
      'idempotency_key', v_retry_key::text,
      'expense_id', v_id::text,
      'core', jsonb_build_object('title','V2 SUBMITTED EDIT v3','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',44),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
    r := public.update_microlink_submitted_expense_v1(jsonb_build_object(
      'idempotency_key', v_retry_key::text,
      'expense_id', v_id::text,
      'core', jsonb_build_object('title','V2 SUBMITTED EDIT v3','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',44),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
    RAISE NOTICE '  idempotent retry: replayed=%', r->>'replayed';
  END;
  SELECT count(*) INTO n_updated_after FROM public.audit_logs
   WHERE expense_id = v_id AND action = 'expense_updated';
  RAISE NOTICE '  expense_updated count after retry: %  (must be exactly 1 more than before retry)', n_updated_after - n_updated_before;

  -- approved must still be locked, for BOTH actions
  UPDATE public.expenses SET status = 'approved' WHERE id = v_id;
  BEGIN
    r := public.update_microlink_submitted_expense_v1(jsonb_build_object(
      'idempotency_key', gen_random_uuid()::text,
      'expense_id', v_id::text,
      'core', jsonb_build_object('title','V2 SUBMITTED EDIT v4','destination','X','trip_start','2026-09-09',
        'category','Travelling (Public and Private Transport)','total_amount',45),
      'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
    RAISE NOTICE '  approved update_submitted: ACCEPTED  <-- WRONG, must stay locked';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '  approved update_submitted: REFUSED  SQLSTATE=%  %', SQLSTATE, left(SQLERRM, 60);
  END;
END $$;

\echo ''
\echo '--- M. ROUTING PRESERVATION: a submitted edit must NOT reroute even if the hierarchy changed ---'
DO $$
DECLARE
  r jsonb; v_id uuid; v_uid text;
  v_tier_before text; v_reviewer_before uuid; v_engineer_before uuid;
  v_tier_after text; v_reviewer_after uuid; v_engineer_after uuid;
BEGIN
  SELECT b.parent_option_value INTO v_uid
  FROM public.expense_form_field_option_branches b
  WHERE b.organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND b.parent_template_id = public._microlink_template_id_v1('Project Unique ID')
    AND b.retired_at IS NULL
  GROUP BY 1
  HAVING count(*) FILTER (WHERE b.field_key='project_id') = 1
     AND bool_and(jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) = 1)
  ORDER BY 1 LIMIT 1;

  r := public.submit_microlink_expense_v1(jsonb_build_object(
    'idempotency_key', gen_random_uuid()::text,
    'core', jsonb_build_object('title','V2 ROUTING GUARD','destination','X','trip_start','2026-09-09',
      'category','Travelling (Public and Private Transport)','total_amount',12),
    'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));
  v_id := (r->>'expense_id')::uuid;

  SELECT approval_tier, assigned_reviewer_id, assigned_engineer_id
    INTO v_tier_before, v_reviewer_before, v_engineer_before
    FROM public.expenses WHERE id = v_id;
  RAISE NOTICE '  routing at submission: tier=%  reviewer=%  engineer=%',
    v_tier_before, v_reviewer_before, v_engineer_before;

  -- simulate the hierarchy having moved on: force a different reviewer/engineer
  -- directly, standing in for "a NEW submission today would route elsewhere".
  UPDATE public.expenses SET assigned_reviewer_id = gen_random_uuid(),
                              assigned_engineer_id = gen_random_uuid()
  WHERE id = v_id;
  SELECT assigned_reviewer_id, assigned_engineer_id INTO v_reviewer_before, v_engineer_before
  FROM public.expenses WHERE id = v_id;

  r := public.update_microlink_submitted_expense_v1(jsonb_build_object(
    'idempotency_key', gen_random_uuid()::text,
    'expense_id', v_id::text,
    'core', jsonb_build_object('title','V2 ROUTING GUARD edited','destination','X','trip_start','2026-09-09',
      'category','Travelling (Public and Private Transport)','total_amount',13),
    'microlink', jsonb_build_object('project_unique_id', v_uid,'from_location','A','to_location','B')));

  SELECT approval_tier, assigned_reviewer_id, assigned_engineer_id
    INTO v_tier_after, v_reviewer_after, v_engineer_after
    FROM public.expenses WHERE id = v_id;
  RAISE NOTICE '  routing after submitted edit: tier unchanged=%  reviewer unchanged=%  engineer unchanged=%  (all MUST be true)',
    v_tier_before IS NOT DISTINCT FROM v_tier_after,
    v_reviewer_before = v_reviewer_after,
    v_engineer_before = v_engineer_after;
END $$;

\echo ''
\echo '################ ROLLING BACK — production untouched ################'
ROLLBACK;

SELECT count(*) AS acceptance_rows_left_in_production
FROM public.expenses WHERE title LIKE 'V2 ACCEPTANCE%' OR title = 'V2 draft';
