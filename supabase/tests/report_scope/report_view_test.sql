-- View Report / Report History authorization tests (DOC-147).
-- Throwaway database only. Order:
--   harness.sql -> 20261019100000_secure_report_scope_v1.sql
--   -> 20261020100000_report_view_for_scoped_users_v1.sql -> this file.
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
  RAISE NOTICE 'TEST % : % %', rpad(label, 60), CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END, detail;
END $f$;

DO $t$
DECLARE
  pat uuid; ml uuid;
  p_adm uuid; p_mgr uuid; p_mgr2 uuid; p_emp uuid;
  m_emp uuid;
  j_mgr uuid; j_mgr2 uuid; j_emp uuid; j_ml uuid;
  r jsonb; n int; failed boolean;
BEGIN
  SELECT id INTO pat FROM public.organizations WHERE name = 'Patidar Travels';
  SELECT id INTO ml  FROM public.organizations WHERE name = 'MicroLink';
  SELECT user_id INTO p_adm  FROM public.organization_memberships WHERE organization_id = pat AND role = 'admin';
  SELECT user_id INTO p_mgr  FROM public.organization_memberships WHERE organization_id = pat AND role = 'engineer' ORDER BY user_id LIMIT 1;
  SELECT user_id INTO p_mgr2 FROM public.organization_memberships WHERE organization_id = pat AND role = 'engineer' ORDER BY user_id DESC LIMIT 1;
  SELECT user_id INTO p_emp  FROM public.organization_memberships WHERE organization_id = pat AND role = 'employee';
  SELECT user_id INTO m_emp  FROM public.organization_memberships WHERE organization_id = ml AND role = 'employee' ORDER BY user_id LIMIT 1;

  -- A completed, previewable job per requester, 120 frozen rows each.
  INSERT INTO public.report_export_jobs (organization_id, requested_by, report_type, format, status, filename, storage_path,
      progress_current, progress_total, preview_columns, parameters, completed_at)
  VALUES (pat, p_mgr, 'detailed_expense', 'csv', 'completed', 'mgr.csv', 'o/mgr.csv', 120, 120, ARRAY['Date','Employee'], '{}', now())
  RETURNING id INTO j_mgr;
  INSERT INTO public.report_export_jobs (organization_id, requested_by, report_type, format, status, filename, storage_path,
      progress_current, progress_total, preview_columns, parameters, completed_at)
  VALUES (pat, p_mgr2, 'detailed_expense', 'csv', 'completed', 'mgr2.csv', 'o/mgr2.csv', 120, 120, ARRAY['Date','Employee'], '{}', now())
  RETURNING id INTO j_mgr2;
  INSERT INTO public.report_export_jobs (organization_id, requested_by, report_type, format, status, filename, storage_path,
      progress_current, progress_total, preview_columns, parameters, completed_at)
  VALUES (pat, p_emp, 'detailed_expense', 'csv', 'completed', 'emp.csv', 'o/emp.csv', 120, 120, ARRAY['Date','Employee'], '{}', now())
  RETURNING id INTO j_emp;
  INSERT INTO public.report_export_jobs (organization_id, requested_by, report_type, format, status, filename, storage_path,
      progress_current, progress_total, preview_columns, parameters, completed_at)
  VALUES (ml, m_emp, 'detailed_expense', 'csv', 'completed', 'ml.csv', 'o/ml.csv', 120, 120, ARRAY['Date','Employee'], '{}', now())
  RETURNING id INTO j_ml;

  INSERT INTO public.report_export_job_rows (job_id, row_index, row_data)
  SELECT j, g, jsonb_build_object('Date', '01-10-2026', 'Employee', 'r' || g)
  FROM unnest(ARRAY[j_mgr, j_mgr2, j_emp, j_ml]) AS j, generate_series(1, 120) AS g;

  -- 1 manager previews own report: paged, total == frozen CSV rows
  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('1a manager previews own report', (r->>'ready')::boolean);
  PERFORM pg_temp.rep('1b preview total == CSV rows (120)', (r->>'total_count')::int = 120, r->>'total_count');
  PERFORM pg_temp.rep('1c page is bounded to 50 rows', jsonb_array_length(r->'rows') = 50);

  PERFORM pg_temp.imp(p_mgr);
  r := public.get_report_export_job_preview_v3(j_mgr, 3, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('1d last page has the remaining 20 rows', jsonb_array_length(r->'rows') = 20);

  -- 2 manager cannot preview a coworker manager's report, nor another org's
  failed := false;
  PERFORM pg_temp.imp(p_mgr);
  BEGIN r := public.get_report_export_job_preview_v3(j_mgr2, 1, 50);
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RESET ROLE;
  PERFORM pg_temp.rep('2a manager cannot preview coworker report', failed);
  failed := false;
  PERFORM pg_temp.imp(p_mgr);
  BEGIN r := public.get_report_export_job_preview_v3(j_ml, 1, 50);
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RESET ROLE;
  PERFORM pg_temp.rep('2b manager cannot preview another organization report', failed);

  -- 3 employee previews own, not a manager's
  PERFORM pg_temp.imp(p_emp);
  r := public.get_report_export_job_preview_v3(j_emp, 1, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('3a employee previews own report', (r->>'ready')::boolean AND (r->>'total_count')::int = 120);
  failed := false;
  PERFORM pg_temp.imp(p_emp);
  BEGIN r := public.get_report_export_job_preview_v3(j_mgr, 1, 50);
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RESET ROLE;
  PERFORM pg_temp.rep('3b employee cannot preview a manager report', failed);

  -- 4 employee in an org WITHOUT teams_enabled cannot preview even their own job
  failed := false;
  PERFORM pg_temp.imp(m_emp);
  BEGIN r := public.get_report_export_job_preview_v3(j_ml, 1, 50);
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RESET ROLE;
  PERFORM pg_temp.rep('4 employee without teams_enabled cannot preview', failed);

  -- 5 history list: scoped viewers see only their own jobs; admin sees the org
  PERFORM pg_temp.imp(p_mgr);
  r := public.list_report_export_jobs_v4(pat, 'detailed_expense', 0, 20);
  RESET ROLE;
  PERFORM pg_temp.rep('5a manager history = own jobs only', (r->>'total_count')::int = 1 AND jsonb_array_length(r->'jobs') = 1);
  PERFORM pg_temp.imp(p_emp);
  r := public.list_report_export_jobs_v4(pat, 'detailed_expense', 0, 20);
  RESET ROLE;
  PERFORM pg_temp.rep('5b employee history = own jobs only', (r->>'total_count')::int = 1 AND (r->'jobs'->0->>'requested_by_me')::boolean);
  PERFORM pg_temp.imp(p_adm);
  r := public.list_report_export_jobs_v4(pat, 'detailed_expense', 0, 20);
  RESET ROLE;
  PERFORM pg_temp.rep('5c admin history = whole organization (unchanged)', (r->>'total_count')::int = 3);
  failed := false;
  PERFORM pg_temp.imp(p_mgr);
  BEGIN r := public.list_report_export_jobs_v4(ml, 'detailed_expense', 0, 20);
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  RESET ROLE;
  PERFORM pg_temp.rep('5d manager cannot list another organization history', failed);

  -- 6 admin preview of any report in own org unchanged
  PERFORM pg_temp.imp(p_adm);
  r := public.get_report_export_job_preview_v3(j_mgr, 1, 50);
  RESET ROLE;
  PERFORM pg_temp.rep('6 admin previews any report in the organization', (r->>'ready')::boolean);

  RAISE EXCEPTION 'ROLLBACK_TEST_DONE';
END
$t$;
