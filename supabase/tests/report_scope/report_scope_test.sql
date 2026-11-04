-- Report-scope behavioural tests (DOC-147). Run against a THROWAWAY database:
--   1. psql -f supabase/tests/report_scope/harness.sql
--   2. psql -f supabase/migrations/20261019100000_secure_report_scope_v1.sql
--   3. psql -f supabase/tests/report_scope/report_scope_test.sql
-- Every case prints 'TEST <name> : PASS|FAIL'; the script ends with an intentional
-- ROLLBACK_TEST_DONE error so it leaves no data behind. Never run against Production.
CREATE OR REPLACE FUNCTION pg_temp.imp(u uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $f$;

CREATE OR REPLACE FUNCTION pg_temp.rep(label text, pass boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  RAISE NOTICE 'TEST % : % %', rpad(label, 58), CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END, detail;
END $f$;

DO $t$
DECLARE
  pat uuid; ml uuid;
  p_mgr uuid; p_emp uuid; p_adm uuid;
  m_mgr uuid; m_emp uuid; m_other uuid; m_tl uuid;
  n int; n2 int; sc uuid[]; subs int; r jsonb; failed boolean;
BEGIN
  SELECT id INTO pat FROM public.organizations WHERE name = 'Patidar Travels';
  SELECT id INTO ml  FROM public.organizations WHERE name = 'MicroLink';
  SELECT user_id INTO p_mgr FROM public.organization_memberships WHERE organization_id = pat AND role::text = 'engineer' AND is_active ORDER BY user_id LIMIT 1;
  SELECT user_id INTO p_emp FROM public.organization_memberships WHERE organization_id = pat AND role::text = 'employee' AND is_active LIMIT 1;
  SELECT user_id INTO p_adm FROM public.organization_memberships WHERE organization_id = pat AND role::text = 'admin' AND is_active LIMIT 1;
  -- MicroLink manager that actually has subordinates
  SELECT m.user_id INTO m_mgr FROM public.organization_memberships m
   WHERE m.organization_id = ml AND m.role::text = 'engineer' AND m.is_active
     AND EXISTS (SELECT 1 FROM public.get_subordinate_user_ids(ml, m.user_id))
   ORDER BY m.user_id LIMIT 1;
  SELECT user_id INTO m_tl FROM public.organization_memberships WHERE organization_id = ml AND role::text IN ('executive','team_leader') AND is_active
     AND EXISTS (SELECT 1 FROM public.get_subordinate_user_ids(ml, user_id)) ORDER BY user_id LIMIT 1;
  SELECT user_id INTO m_emp FROM public.organization_memberships WHERE organization_id = ml AND role::text = 'employee' AND is_active ORDER BY user_id LIMIT 1;
  -- an MicroLink employee that is NOT a subordinate of m_mgr
  SELECT m.user_id INTO m_other FROM public.organization_memberships m
   WHERE m.organization_id = ml AND m.role::text = 'employee' AND m.is_active
     AND m.user_id NOT IN (SELECT user_id FROM public.get_subordinate_user_ids(ml, m_mgr))
     AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.user_id = m.user_id AND e.organization_id = ml)
   ORDER BY m.user_id LIMIT 1;

  PERFORM pg_temp.rep('fixtures found (pat mgr/emp/adm, ml mgr/emp/other)',
    p_mgr IS NOT NULL AND p_emp IS NOT NULL AND p_adm IS NOT NULL AND m_mgr IS NOT NULL AND m_emp IS NOT NULL AND m_other IS NOT NULL);
  PERFORM pg_temp.rep('patidar teams_enabled ON / approval_hierarchy OFF',
    public.org_feature_enabled(pat, 'teams_enabled') AND NOT public.org_feature_enabled(pat, 'approval_hierarchy'));

  -- 1 Patidar manager with zero team members -> scope = [self]
  PERFORM pg_temp.imp(p_mgr);
  sc := public.get_my_report_scope_v1(pat);
  PERFORM pg_temp.rep('1 patidar manager (no team) scope = self only', cardinality(sc) = 1 AND sc[1] = p_mgr);
  SELECT count(*) INTO n FROM public.get_team_expenses_for_members(pat, ARRAY[p_mgr]);
  RESET ROLE;
  SELECT count(*) INTO n2 FROM public.expenses WHERE user_id = p_mgr AND organization_id = pat;
  PERFORM pg_temp.rep('2 patidar manager sees own expenses', n = LEAST(n2, 2000), format('rpc=%s actual=%s', n, n2));

  -- manager asks for an unrelated coworker (the patidar employee) -> nothing
  PERFORM pg_temp.imp(p_mgr);
  SELECT count(*) INTO n FROM public.get_team_expenses_for_members(pat, ARRAY[p_emp, p_adm]);
  RESET ROLE;
  PERFORM pg_temp.rep('3 patidar manager requesting unrelated users -> 0 rows', n = 0, format('rows=%s', n));

  -- manager asks for another org's employee, with each org id -> nothing
  PERFORM pg_temp.imp(p_mgr);
  SELECT count(*) INTO n FROM public.get_team_expenses_for_members(pat, ARRAY[m_emp]);
  SELECT count(*) INTO n2 FROM public.get_team_expenses_for_members(ml, ARRAY[m_emp]);
  RESET ROLE;
  PERFORM pg_temp.rep('4 patidar manager -> microlink employee (both org ids) -> 0', n = 0 AND n2 = 0);

  -- 5 employee: own id allowed, coworker blocked, other org blocked
  PERFORM pg_temp.imp(p_emp);
  sc := public.get_my_report_scope_v1(pat);
  SELECT count(*) INTO n FROM public.get_team_expenses_for_members(pat, ARRAY[p_emp]);
  SELECT count(*) INTO n2 FROM public.get_team_expenses_for_members(pat, ARRAY[p_mgr, p_adm]);
  RESET ROLE;
  PERFORM pg_temp.rep('5a employee scope = [self]', cardinality(sc) = 1 AND sc[1] = p_emp);
  PERFORM pg_temp.rep('5b employee own id allowed',
    n = LEAST((SELECT count(*) FROM public.expenses WHERE user_id = p_emp AND organization_id = pat), 2000));
  PERFORM pg_temp.rep('5c employee requesting coworker -> 0 rows', n2 = 0);

  PERFORM pg_temp.imp(p_emp);
  SELECT count(*) INTO n FROM public.get_team_expenses_for_members(ml, ARRAY[m_emp]);
  SELECT cardinality(public.get_my_report_scope_v1(ml)) INTO n2;
  RESET ROLE;
  PERFORM pg_temp.rep('6 employee requesting other org user/org -> 0 rows, empty scope', n = 0 AND n2 = 0);

  -- 7 microlink manager keeps self + subordinates, nothing else
  PERFORM pg_temp.imp(m_mgr);
  sc := public.get_my_report_scope_v1(ml);
  SELECT count(*) INTO n FROM public.get_team_expenses_for_members(ml, ARRAY[m_other]);
  RESET ROLE;
  SELECT count(*) INTO subs FROM public.get_subordinate_user_ids(ml, m_mgr);
  PERFORM pg_temp.rep('7a microlink manager scope = self + subordinates',
    cardinality(sc) = subs + 1 AND m_mgr = ANY(sc), format('scope=%s subs=%s', cardinality(sc), subs));
  PERFORM pg_temp.rep('7b microlink manager -> unrelated employee -> 0 rows', n = 0);

  -- 8 microlink TL / executive
  IF m_tl IS NOT NULL THEN
    PERFORM pg_temp.imp(m_tl);
    sc := public.get_my_report_scope_v1(ml);
    RESET ROLE;
    SELECT count(*) INTO subs FROM public.get_subordinate_user_ids(ml, m_tl);
    PERFORM pg_temp.rep('8 microlink TL/executive scope = self + subordinates',
      m_tl = ANY(sc) AND cardinality(sc) >= subs + 1);
  END IF;

  -- 9 admin: whole org, never another org
  PERFORM pg_temp.imp(p_adm);
  sc := public.get_my_report_scope_v1(pat);
  SELECT cardinality(public.get_my_report_scope_v1(ml)) INTO n;
  RESET ROLE;
  SELECT count(*) INTO n2 FROM public.profiles WHERE organization_id = pat;
  PERFORM pg_temp.rep('9a patidar admin scope = all patidar profiles', cardinality(sc) >= n2 AND p_emp = ANY(sc));
  PERFORM pg_temp.rep('9b patidar admin has no scope in microlink', n = 0);

  -- 10 daily project report page: employee self allowed, coworker blocked
  PERFORM pg_temp.imp(p_emp);
  BEGIN
    r := public.get_daily_project_report_page_v1(pat, NULL, NULL, NULL, NULL, true, NULL, NULL, 10);
    PERFORM pg_temp.rep('10a employee daily report (team_scoped self) allowed', r IS NOT NULL);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rep('10a employee daily report (team_scoped self) allowed', false, SQLERRM);
  END;
  failed := false;
  BEGIN
    r := public.get_daily_project_report_page_v1(pat, NULL, NULL, p_mgr, NULL, true, NULL, NULL, 10);
  EXCEPTION WHEN OTHERS THEN failed := true;
  END;
  PERFORM pg_temp.rep('10b employee daily report for coworker blocked', failed);
  failed := false;
  BEGIN
    r := public.get_daily_project_report_page_v1(pat, NULL, NULL, NULL, ARRAY[p_mgr], true, NULL, NULL, 10);
  EXCEPTION WHEN OTHERS THEN failed := true;
  END;
  PERFORM pg_temp.rep('10c employee daily report user_ids=[coworker] blocked', failed);
  failed := false;
  BEGIN
    r := public.get_daily_project_report_page_v1(pat, NULL, NULL, NULL, NULL, false, NULL, NULL, 10);
  EXCEPTION WHEN OTHERS THEN failed := true;
  END;
  PERFORM pg_temp.rep('10d employee org-wide daily report (team_scoped=false) blocked', failed);
  RESET ROLE;

  -- 11 export jobs
  PERFORM pg_temp.imp(p_emp);
  failed := false;
  BEGIN
    r := public.create_expense_report_export_job_v1(pat, 'claim_approval', '{}'::jsonb, true, 'csv');
  EXCEPTION WHEN OTHERS THEN failed := true;
  END;
  PERFORM pg_temp.rep('11a employee claim_approval export blocked', failed);
  failed := false;
  BEGIN
    r := public.create_expense_report_export_job_v1(pat, 'detailed_expense', jsonb_build_object('user_ids', jsonb_build_array(p_mgr)), true, 'csv');
  EXCEPTION WHEN OTHERS THEN failed := true;
  END;
  PERFORM pg_temp.rep('11b employee detailed export for coworker blocked', failed);
  failed := false;
  BEGIN
    r := public.create_expense_report_export_job_v1(pat, 'detailed_expense', '{}'::jsonb, false, 'csv');
  EXCEPTION WHEN OTHERS THEN failed := true;
  END;
  PERFORM pg_temp.rep('11c employee org-wide (team_scoped=false) export blocked', failed);
  BEGIN
    r := public.create_expense_report_export_job_v1(pat, 'detailed_expense', '{}'::jsonb, true, 'csv');
    RESET ROLE;
    PERFORM pg_temp.rep('11d employee own detailed export allowed + frozen to [self]',
      (SELECT jsonb_array_length(parameters->'user_ids') = 1 AND (parameters->'user_ids'->>0)::uuid = p_emp
         FROM public.report_export_jobs WHERE id = (r->>'job_id')::uuid));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rep('11d employee own detailed export allowed + frozen to [self]', false, SQLERRM);
  END;

  -- 12 submitter profiles
  PERFORM pg_temp.imp(p_emp);
  SELECT count(*) INTO n FROM public.get_expense_submitter_profiles(pat, ARRAY[p_emp]);
  SELECT count(*) INTO n2 FROM public.get_expense_submitter_profiles(pat, ARRAY[m_emp, m_mgr]);
  RESET ROLE;
  PERFORM pg_temp.rep('12a submitter profiles: own id returned', n = 1);
  PERFORM pg_temp.rep('12b submitter profiles: other-org ids not returned', n2 = 0, format('rows=%s', n2));

  -- 13 anon
  failed := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM count(*) FROM public.get_team_expenses_for_members(pat, ARRAY[p_emp]);
  EXCEPTION WHEN insufficient_privilege THEN failed := true;
  END;
  RESET ROLE;
  PERFORM pg_temp.rep('13 anon cannot execute get_team_expenses_for_members', failed);
  failed := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM count(*) FROM public.get_expense_submitter_profiles(pat, ARRAY[p_emp]);
  EXCEPTION WHEN insufficient_privilege THEN failed := true;
  END;
  RESET ROLE;
  PERFORM pg_temp.rep('14 anon cannot execute get_expense_submitter_profiles', failed);

  -- 16 formal team (local harness): manager leads the employee -> self + member; coworker manager still excluded
  INSERT INTO public.teams(organization_id, name, manager_user_id) VALUES (pat, 'qa team', p_mgr);
  INSERT INTO public.team_members(team_id, user_id, organization_id)
    SELECT t.id, p_emp, pat FROM public.teams t WHERE t.name = 'qa team';
  PERFORM pg_temp.imp(p_mgr);
  sc := public.get_my_report_scope_v1(pat);
  SELECT count(*) INTO n FROM public.get_team_expenses_for_members(pat, ARRAY[p_mgr, p_emp]);
  SELECT count(*) INTO n2 FROM public.get_team_expenses_for_members(pat, ARRAY[p_adm]);
  RESET ROLE;
  PERFORM pg_temp.rep('16a team manager scope = self + team members', cardinality(sc) = 2 AND p_emp = ANY(sc) AND p_mgr = ANY(sc));
  PERFORM pg_temp.rep('16b team manager gets both members expenses, not admin', n = 4 AND n2 = 0, format('rows=%s admin=%s', n, n2));
  PERFORM pg_temp.imp(p_emp);
  sc := public.get_my_report_scope_v1(pat);
  RESET ROLE;
  PERFORM pg_temp.rep('16c team member (employee) scope stays [self]', cardinality(sc) = 1 AND sc[1] = p_emp);

  RAISE EXCEPTION 'ROLLBACK_TEST_DONE';
END
$t$;
