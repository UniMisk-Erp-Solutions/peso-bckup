-- Daily Project Report "View Report" (DOC-101 §11). Throwaway database only. Order:
--   harness.sql -> 20261019100000_secure_report_scope_v1.sql
--   -> 20261020100000_report_view_for_scoped_users_v1.sql
--   -> 20261024100000_daily_project_preview_sort_kinds_v1.sql -> this file.
-- Ends with an intentional ROLLBACK_TEST_DONE error so nothing is left behind.

CREATE OR REPLACE FUNCTION pg_temp.imp(u uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $f$;

CREATE OR REPLACE FUNCTION pg_temp.rep(label text, pass boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  RAISE NOTICE 'TEST % : % %', rpad(label, 62), CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END, detail;
END $f$;

DO $t$
DECLARE
  pat uuid; ml uuid; p_adm uuid; p_mgr uuid; p_mgr2 uuid; p_emp uuid; m_emp uuid;
  j_mgr uuid; j_old uuid; j_ml uuid;
  r jsonb; failed boolean; cols text[];
  n constant int := 1234;
  a numeric; b numeric;
BEGIN
  SELECT id INTO pat FROM public.organizations WHERE name = 'Patidar Travels';
  SELECT id INTO ml  FROM public.organizations WHERE name = 'MicroLink';
  SELECT user_id INTO p_adm  FROM public.organization_memberships WHERE organization_id = pat AND role = 'admin';
  SELECT user_id INTO p_mgr  FROM public.organization_memberships WHERE organization_id = pat AND role = 'engineer' ORDER BY user_id LIMIT 1;
  SELECT user_id INTO p_mgr2 FROM public.organization_memberships WHERE organization_id = pat AND role = 'engineer' ORDER BY user_id DESC LIMIT 1;
  SELECT user_id INTO p_emp  FROM public.organization_memberships WHERE organization_id = pat AND role = 'employee';
  SELECT user_id INTO m_emp  FROM public.organization_memberships WHERE organization_id = ml AND role = 'employee' ORDER BY user_id LIMIT 1;

  -- the exact worker CSV header array / order
  cols := ARRAY['Track Date','Voucher No','project id','project name','Employee','Employee Code','Location','Total Resource',
    'Food','Over Time','Presence','Remarks','Other Remarks','Petrol Cost','Material Cost','Travelling Cost','Phone Exp.',
    'Hotel Exp.','Transport Exp','Contra Bill','Other Exp.','Site Id/RO Code','percent'];

  INSERT INTO public.report_export_jobs (organization_id, requested_by, report_type, format, status, filename, storage_path,
      progress_current, progress_total, preview_columns, parameters, completed_at)
  VALUES (pat, p_mgr, 'daily_project_report', 'csv', 'completed', 'daily-project-report_2026-10-16.csv', 'o/d.csv', n, n, cols, '{}', now())
  RETURNING id INTO j_mgr;
  -- an OLDER completed job: no stored preview_columns / rows
  INSERT INTO public.report_export_jobs (organization_id, requested_by, report_type, format, status, filename, storage_path,
      progress_current, progress_total, parameters, completed_at)
  VALUES (pat, p_mgr, 'daily_project_report', 'csv', 'completed', 'old.csv', 'o/old.csv', 50, 50, '{}', now())
  RETURNING id INTO j_old;
  INSERT INTO public.report_export_jobs (organization_id, requested_by, report_type, format, status, filename, storage_path,
      progress_current, progress_total, preview_columns, parameters, completed_at)
  VALUES (ml, m_emp, 'daily_project_report', 'csv', 'completed', 'ml.csv', 'o/ml.csv', 5, 5, cols, '{}', now())
  RETURNING id INTO j_ml;

  -- Same shape the worker stores: strings for text cells, JSON numbers for cost cells,
  -- "" for empty cells; Track Date is DD-MM-YYYY and rows are NOT in date order on purpose.
  INSERT INTO public.report_export_job_rows (job_id, row_index, row_data)
  SELECT j_mgr, g - 1, (
    SELECT jsonb_object_agg(c, CASE
      WHEN c = 'Track Date' THEN to_jsonb(to_char(date '2026-01-01' + ((g * 37) % 300), 'DD-MM-YYYY'))
      WHEN c = 'Employee' THEN to_jsonb('Emp ' || (g % 17))
      WHEN c = 'Petrol Cost' THEN to_jsonb((g % 90) + 1)
      WHEN c = 'Travelling Cost' THEN to_jsonb(CASE WHEN g % 3 = 0 THEN 100 + (g % 7) ELSE NULL END)
      WHEN c = 'percent' THEN to_jsonb(50)
      ELSE to_jsonb(''::text) END)
    FROM unnest(cols) AS c)
  FROM generate_series(1, n) AS g;
  INSERT INTO public.report_export_job_rows (job_id, row_index, row_data)
  SELECT j_ml, g - 1, jsonb_build_object('Track Date', '01-10-2026') FROM generate_series(1, 5) g;

  -- 1 View Report for a Daily Project job: ready, columns == CSV columns, total == CSV rows
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('1a daily preview is ready', (r->>'ready')::boolean);
  PERFORM pg_temp.rep('1b preview columns == worker CSV header array/order',
    (SELECT array_agg(x ORDER BY o) FROM jsonb_array_elements_text(r->'columns') WITH ORDINALITY t(x,o)) = cols);
  PERFORM pg_temp.rep('1c preview total == CSV rows', (r->>'total_count')::int = n, r->>'total_count');
  PERFORM pg_temp.rep('1d page 1 returns exactly 50 rows', jsonb_array_length(r->'rows') = 50);

  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 2, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('1e page 2 works and continues the order',
    jsonb_array_length(r->'rows') = 50 AND (r->>'page')::int = 2);
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 25, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('1f last page holds the remainder (1234 - 24*50 = 34)', jsonb_array_length(r->'rows') = 34);

  -- 2 Track Date sorts chronologically (not as DD-MM-YYYY text)
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 200, 'Track Date', 'asc');
  RESET ROLE;
  PERFORM pg_temp.rep('2a Track Date asc is chronological',
    (SELECT bool_and(d >= lag_d OR lag_d IS NULL) FROM (
       SELECT to_date(e->>'Track Date','DD-MM-YYYY') AS d,
              lag(to_date(e->>'Track Date','DD-MM-YYYY')) OVER (ORDER BY o) AS lag_d
       FROM jsonb_array_elements(r->'rows') WITH ORDINALITY t(e,o)) q));

  -- 3 cost columns sort numerically, blanks last
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 5, 'Petrol Cost', 'desc');
  RESET ROLE;
  a := (r->'rows'->0->>'Petrol Cost')::numeric; b := (r->'rows'->4->>'Petrol Cost')::numeric;
  PERFORM pg_temp.rep('3a Petrol Cost desc is numeric (90 first, not text order)', a = 90 AND a >= b, format('%s..%s', a, b));
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 50, 'Travelling Cost', 'asc');
  RESET ROLE;
  PERFORM pg_temp.rep('3b blank Travelling Cost cells sort last',
    (r->'rows'->0->>'Travelling Cost') ~ '^1[0-9][0-9]$');

  -- 4 server-side filters
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 50, NULL, 'asc', '{"Employee":{"contains":"Emp 3"}}'::jsonb);
  RESET ROLE;
  PERFORM pg_temp.rep('4a text filter narrows server-side', (r->>'filtered_total_count')::int < n AND (r->>'filtered_total_count')::int > 0 AND (r->>'total_count')::int = n);
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 50, NULL, 'asc', '{"Petrol Cost":{"min":"80"}}'::jsonb);
  RESET ROLE;
  PERFORM pg_temp.rep('4b numeric min filter', (r->>'filtered_total_count')::int > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'rows') e WHERE (e->>'Petrol Cost')::numeric < 80));

  -- 5 an older job without stored rows says so (never faked)
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_old, 1, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('5 old job -> ready=false, no_preview_available',
    NOT (r->>'ready')::boolean AND r->>'reason' = 'no_preview_available');

  -- 6 authorization is unchanged for Daily Project jobs
  failed := false;
  PERFORM pg_temp.imp(p_mgr2);
  BEGIN r := public.get_report_export_job_preview_v3(j_mgr, 1, 50);
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RESET ROLE;
  PERFORM pg_temp.rep('6a coworker manager cannot preview this daily report', failed);
  failed := false;
  PERFORM pg_temp.imp(p_mgr);
  BEGIN r := public.get_report_export_job_preview_v3(j_ml, 1, 50);
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RESET ROLE;
  PERFORM pg_temp.rep('6b cross-org daily preview denied', failed);
  failed := false;
  PERFORM pg_temp.imp(p_emp);
  BEGIN r := public.get_report_export_job_preview_v3(j_mgr, 1, 50);
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RESET ROLE;
  PERFORM pg_temp.rep('6c employee cannot preview a manager daily report', failed);
  PERFORM pg_temp.imp(p_adm);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('6d admin previews any daily report in the organization', (r->>'ready')::boolean);

  RAISE EXCEPTION 'ROLLBACK_TEST_DONE';
END
$t$;
