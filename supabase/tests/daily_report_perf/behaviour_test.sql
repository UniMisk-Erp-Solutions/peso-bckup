-- Behaviour / isolation / determinism tests for the group-first Daily Project row producer
-- (DOC-101 §10). Throwaway database only. Order: schema.sql, legacy.sql, prod_state.sql,
-- the migration, seed.sql (any size), then this file. Ends with an intentional
-- ROLLBACK_TEST_DONE error so nothing is left behind.
CREATE OR REPLACE FUNCTION pg_temp.rep(label text, pass boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  RAISE NOTICE 'TEST % : % %', rpad(label, 64), CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END, detail;
END $f$;

DO $t$
DECLARE
  org  uuid := '00000000-0000-0000-0000-00000000000a';
  org2 uuid := '00000000-0000-0000-0000-00000000000b';
  cfg jsonb := jsonb_build_object('fieldMappings', jsonb_build_object(
      'projectId', 'template:51181324-68cc-4174-bbe0-4834e5e22c48',
      'projectName', 'template:7ae2b9f5-9c7a-456c-9403-314680526741',
      'location', 'template:5308e883-78a4-4bee-abed-67f4e0e5fee8'),
    'categoryMappings', '{}'::jsonb);
  a jsonb; b jsonb; c jsonb; snap timestamptz; n int; forged uuid[]; mine uuid[]; keys_a text; keys_b text;
BEGIN
  -- 1 forged user ids from another organisation never widen scope
  SELECT array_agg(user_id) INTO forged FROM public.profiles WHERE organization_id = org2;
  IF forged IS NULL THEN forged := ARRAY[gen_random_uuid()]; END IF;
  a := public.report_daily_project_rows_v1(org, cfg, NULL, NULL, NULL, forged, NULL, NULL, 250, true);
  PERFORM pg_temp.rep('1 other-organisation user ids return no rows', jsonb_array_length(a->'rows') = 0 AND (a->>'total_count')::int = 0);

  -- 2 user_ids restrict to exactly those employees
  SELECT array_agg(user_id) INTO mine FROM (SELECT user_id FROM public.profiles WHERE organization_id = org ORDER BY user_id LIMIT 3) q;
  a := public.report_daily_project_rows_v1(org, cfg, NULL, NULL, NULL, mine, NULL, NULL, 2000, true);
  PERFORM pg_temp.rep('2 requested employees only',
    jsonb_array_length(a->'rows') > 0 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(a->'rows') e WHERE NOT ((e->>'user_id')::uuid = ANY (mine))));
  PERFORM pg_temp.rep('2b total_count equals the number of rows when all fit one page',
    (a->>'total_count')::int = jsonb_array_length(a->'rows'));

  -- 3 deterministic: same snapshot + cursor => identical page (retry safety)
  a := public.report_daily_project_rows_v1(org, cfg, NULL, NULL, NULL, NULL, NULL, NULL, 250, true);
  snap := (a->>'snapshot_at')::timestamptz;
  b := public.report_daily_project_rows_v1(org, cfg, NULL, NULL, NULL, NULL, snap, a->'next_cursor', 250, false);
  c := public.report_daily_project_rows_v1(org, cfg, NULL, NULL, NULL, NULL, snap, a->'next_cursor', 250, false);
  PERFORM pg_temp.rep('3 same cursor twice returns the identical page', b->'rows' = c->'rows' AND b->'next_cursor' IS NOT DISTINCT FROM c->'next_cursor');

  -- 4 pages do not overlap and are strictly ordered by (track_date, user_id, project_id)
  PERFORM pg_temp.rep('4 next page starts strictly after the cursor', (
    SELECT bool_and((e->>'track_date', e->>'user_id', e->>'project_id') > (a->'next_cursor'->>'track_date', a->'next_cursor'->>'user_id', a->'next_cursor'->>'project_id'))
    FROM jsonb_array_elements(b->'rows') e));
  PERFORM pg_temp.rep('4b rows within a page are ordered', (
    SELECT bool_and((e->>'track_date', e->>'user_id', e->>'project_id') >= (l->>'track_date', l->>'user_id', l->>'project_id'))
    FROM (SELECT e, lag(e) OVER () AS l FROM jsonb_array_elements(a->'rows') e) s WHERE l IS NOT NULL));

  -- 5 totals only on request
  PERFORM pg_temp.rep('5 total_count is NULL when not requested', (b->>'total_count') IS NULL AND (a->>'total_count') IS NOT NULL);

  -- 6 snapshot freezes the population: an expense approved after the snapshot is not in later pages
  INSERT INTO public.expenses(organization_id, user_id, status, total_amount, trip_start, transaction_number, title, created_at)
    SELECT org, user_id, 'approved', 999, DATE '2099-01-01', 'LATE-1', 'late', now() + interval '1 hour'
    FROM public.profiles WHERE organization_id = org LIMIT 1;
  b := public.report_daily_project_rows_v1(org, cfg, NULL, NULL, NULL, NULL, snap, NULL, 2000, true);
  PERFORM pg_temp.rep('6 rows created after the snapshot are excluded',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b->'rows') e, jsonb_array_elements(e->'source_expenses') s WHERE s->>'transaction_number' = 'LATE-1'));

  -- 7 grants: service_role only (the scope wrappers are the only callers)
  PERFORM pg_temp.rep('7 anon/authenticated cannot execute the producer',
    NOT has_function_privilege('anon', 'public.report_daily_project_rows_v1(uuid, jsonb, date, date, uuid, uuid[], timestamp with time zone, jsonb, integer, boolean)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.report_daily_project_rows_v1(uuid, jsonb, date, date, uuid, uuid[], timestamp with time zone, jsonb, integer, boolean)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.report_daily_project_rows_v1(uuid, jsonb, date, date, uuid, uuid[], timestamp with time zone, jsonb, integer, boolean)', 'EXECUTE'));

  -- 8 source expenses of every group are complete (counts per page equal the sum of source_expenses)
  PERFORM pg_temp.rep('8 page_source_count equals the source expenses in the page',
    (a->>'page_source_count')::int = (SELECT COALESCE(sum(jsonb_array_length(e->'source_expenses')), 0) FROM jsonb_array_elements(a->'rows') e));

  RAISE EXCEPTION 'ROLLBACK_TEST_DONE';
END
$t$;
