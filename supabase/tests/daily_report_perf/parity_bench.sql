-- Daily Project Report: legacy vs group-first paging (DOC-101 §10). Throwaway database only.
-- Pages the LEGACY function and the NEW function (report_daily_project_rows_v1) with the
-- same cursor semantics (250 rows/page) and compares every returned row, the totals and the
-- cursor chain. Prints one BENCH line per algorithm and a PARITY line.
--   psql -At -v org=00000000-0000-0000-0000-00000000000a -f parity_bench.sql
-- Requires: schema.sql, legacy.sql, the migration, seed.sql.
CREATE OR REPLACE FUNCTION pg_temp.cfg() RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'fieldMappings', jsonb_build_object(
       'projectId',  'template:51181324-68cc-4174-bbe0-4834e5e22c48',
       'projectName','template:7ae2b9f5-9c7a-456c-9403-314680526741',
       'location',   'template:5308e883-78a4-4bee-abed-67f4e0e5fee8'),
    'categoryMappings', jsonb_build_object(
       'petrol_cost', jsonb_build_array('Petrol Expense (Bike and Car)'),
       'material_cost', jsonb_build_array('Material Purchase'),
       'travelling_cost', jsonb_build_array('Travelling (Public and Private Transport)'),
       'phone_exp', jsonb_build_array('Mobile Recharges'),
       'hotel_exp', jsonb_build_array('Hotel/Guest House'),
       'contra_bill', jsonb_build_array('Local Manpower'),
       'other_exp', jsonb_build_array('Laptop Rent'),
       'transport_exp', '[]'::jsonb))
$f$;

CREATE OR REPLACE FUNCTION pg_temp.walk(p_algo text, p_org uuid, p_from date, p_to date, p_user uuid, p_users uuid[], p_cfg jsonb DEFAULT NULL)
RETURNS TABLE (pages int, rows_total int, total_count int, src_count int, total_ms numeric, max_page_ms numeric, median_ms numeric, rows_md5 text, cursor_md5 text)
LANGUAGE plpgsql AS $f$
DECLARE
  cur jsonb := NULL; snap timestamptz := NULL; r jsonb; t0 timestamptz; ms numeric; i int := 0;
  tot int := NULL; sc int := NULL; times numeric[] := ARRAY[]::numeric[]; all_rows text := ''; all_cur text := '';
  whole0 timestamptz := clock_timestamp(); n_rows int := 0;
BEGIN
  LOOP
    t0 := clock_timestamp();
    IF p_algo = 'legacy' THEN
      r := public.report_daily_project_rows_legacy(p_org, COALESCE(p_cfg, pg_temp.cfg()), p_from, p_to, p_user, p_users, snap, cur, 250, i = 0);
    ELSE
      r := public.report_daily_project_rows_v1(p_org, COALESCE(p_cfg, pg_temp.cfg()), p_from, p_to, p_user, p_users, snap, cur, 250, i = 0);
    END IF;
    ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
    times := times || ms;
    IF i = 0 THEN snap := (r->>'snapshot_at')::timestamptz; tot := (r->>'total_count')::int; sc := (r->>'source_count')::int; END IF;
    i := i + 1;
    n_rows := n_rows + jsonb_array_length(r->'rows');
    all_rows := all_rows || md5((r->'rows')::text);
    all_cur := all_cur || COALESCE(md5((r->'next_cursor')::text), 'end') || (r->>'page_source_count') || '/' || (r->>'returned');
    EXIT WHEN NOT COALESCE((r->>'has_more')::boolean, false) OR r->'next_cursor' IS NULL OR i >= 400;
    cur := r->'next_cursor';
  END LOOP;
  RETURN QUERY SELECT i, n_rows, tot, sc,
    round(extract(epoch FROM clock_timestamp() - whole0) * 1000, 0),
    round((SELECT max(x) FROM unnest(times) x), 0),
    round((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM unnest(times) x)::numeric, 0),
    md5(all_rows), md5(all_cur);
END $f$;

\echo === all-time, all employees
SELECT 'BENCH legacy | pages=' || pages || ' rows=' || rows_total || ' total_count=' || total_count || ' src=' || src_count
       || ' total_ms=' || total_ms || ' max_page_ms=' || max_page_ms || ' median_ms=' || median_ms || ' rows_md5=' || rows_md5 AS l,
       rows_md5 AS lm, cursor_md5 AS lc
FROM pg_temp.walk('legacy', :'org'::uuid, NULL, NULL, NULL, NULL) \gset
\echo :l
SELECT 'BENCH new    | pages=' || pages || ' rows=' || rows_total || ' total_count=' || total_count || ' src=' || src_count
       || ' total_ms=' || total_ms || ' max_page_ms=' || max_page_ms || ' median_ms=' || median_ms || ' rows_md5=' || rows_md5 AS n,
       rows_md5 AS nm, cursor_md5 AS nc
FROM pg_temp.walk('new', :'org'::uuid, NULL, NULL, NULL, NULL) \gset
\echo :n
SELECT 'PARITY all-time: rows ' || CASE WHEN :'lm' = :'nm' THEN 'IDENTICAL' ELSE 'DIFFERENT' END
       || ', page/cursor chain ' || CASE WHEN :'lc' = :'nc' THEN 'IDENTICAL' ELSE 'DIFFERENT' END;

-- Filter / mapping matrix: every scenario must be IDENTICAL between legacy and new.
CREATE OR REPLACE FUNCTION pg_temp.scenario(p_name text, p_org uuid, p_from date, p_to date, p_user uuid, p_users uuid[], p_cfg jsonb DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l record; n record;
BEGIN
  SELECT * INTO l FROM pg_temp.walk('legacy', p_org, p_from, p_to, p_user, p_users, p_cfg);
  SELECT * INTO n FROM pg_temp.walk('new', p_org, p_from, p_to, p_user, p_users, p_cfg);
  RETURN 'SCENARIO ' || rpad(p_name, 46) || ' : ' || CASE WHEN l.rows_md5 = n.rows_md5 AND l.cursor_md5 = n.cursor_md5
         AND l.total_count IS NOT DISTINCT FROM n.total_count AND l.src_count IS NOT DISTINCT FROM n.src_count THEN 'IDENTICAL' ELSE 'DIFFERENT' END
         || ' (rows=' || n.rows_total || ' total=' || n.total_count || ' pages=' || n.pages || ')';
END $f$;

SELECT pg_temp.scenario('date range 2025-03..2025-05', :'org'::uuid, DATE '2025-03-01', DATE '2025-05-31', NULL, NULL);
SELECT pg_temp.scenario('only date_from', :'org'::uuid, DATE '2025-10-01', NULL, NULL, NULL);
SELECT pg_temp.scenario('single user', :'org'::uuid, NULL, NULL, '20000000-0000-0000-0000-000000000007', NULL);
SELECT pg_temp.scenario('user list (5)', :'org'::uuid, NULL, NULL, NULL,
   ARRAY['20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000011','20000000-0000-0000-0000-000000000040',
         '20000000-0000-0000-0000-000000000099','20000000-0000-0000-0000-000000000123']::uuid[]);
SELECT pg_temp.scenario('user list + date range', :'org'::uuid, DATE '2025-02-01', DATE '2025-12-31', NULL,
   ARRAY['20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000011']::uuid[]);
SELECT pg_temp.scenario('empty user list', :'org'::uuid, NULL, NULL, NULL, ARRAY[]::uuid[]);
SELECT pg_temp.scenario('mapping: location=base:destination', :'org'::uuid, NULL, NULL, NULL, NULL,
   jsonb_set(pg_temp.cfg(), '{fieldMappings,location}', '"base:destination"'));
SELECT pg_temp.scenario('mapping: projectId=base:title', :'org'::uuid, DATE '2025-01-01', DATE '2025-03-31', NULL, NULL,
   jsonb_set(pg_temp.cfg(), '{fieldMappings,projectId}', '"base:title"'));
SELECT pg_temp.scenario('mapping: no projectId (all one group/day)', :'org'::uuid, DATE '2025-01-01', DATE '2025-06-30', NULL, NULL,
   jsonb_set(pg_temp.cfg(), '{fieldMappings,projectId}', '""'));
SELECT pg_temp.scenario('other organisation', '00000000-0000-0000-0000-00000000000b'::uuid, NULL, NULL, NULL, NULL);
SELECT pg_temp.scenario('unknown organisation', gen_random_uuid(), NULL, NULL, NULL, NULL);
