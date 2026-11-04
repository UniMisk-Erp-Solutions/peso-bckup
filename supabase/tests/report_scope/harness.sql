-- Minimal local schema + seed that mirrors the production objects the report RPCs touch.
-- Throwaway instance only. No production data.
DO $r$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END
$r$;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.profiles (
  user_id uuid, organization_id uuid, name text, email text, balance numeric DEFAULT 0,
  employee_id text, is_active boolean DEFAULT true, is_master_admin boolean DEFAULT false,
  reporting_engineer_id uuid
);
CREATE TABLE public.organization_memberships (
  user_id uuid, organization_id uuid, role text, is_active boolean DEFAULT true,
  is_accountant_cashier boolean DEFAULT false
);
CREATE TABLE public.organization_features (organization_id uuid, feature_key text, enabled boolean);
CREATE TABLE public.organization_settings (organization_id uuid, daily_expense_report_config jsonb);
CREATE TABLE public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, name text,
  team_leader_user_id uuid, executive_user_id uuid, manager_user_id uuid
);
CREATE TABLE public.team_members (team_id uuid, user_id uuid, organization_id uuid);
CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid,
  title text, total_amount numeric, status text DEFAULT 'submitted', created_at timestamptz DEFAULT now(),
  trip_start date, trip_end date, category text, purpose text, destination text,
  transaction_number text, batch_id uuid
);
CREATE TABLE public.report_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, requested_by uuid,
  report_type text, format text, parameters jsonb, config_snapshot jsonb, dedupe_key text,
  status text, created_at timestamptz DEFAULT now(),
  progress_current integer, progress_total integer, filename text, storage_path text,
  file_size_bytes bigint, started_at timestamptz, completed_at timestamptz, expires_at timestamptz,
  worker_heartbeat_at timestamptz, error_message_safe text, preview_columns text[]
);
CREATE TABLE public.report_export_job_rows (job_id uuid, row_index integer, row_data jsonb);
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.objects (bucket_id text, name text);
CREATE UNIQUE INDEX ON public.report_export_jobs(dedupe_key) WHERE status IN ('queued','running');

CREATE FUNCTION public.org_feature_enabled(p_organization_id uuid, p_feature_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_features ofe
    WHERE ofe.organization_id = p_organization_id AND ofe.feature_key = p_feature_key AND ofe.enabled = true);
$$;

-- identical to production
CREATE FUNCTION public.get_subordinate_user_ids(p_organization_id uuid, p_leader_user_id uuid)
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH RECURSIVE subtree AS (
    SELECT p.user_id FROM public.profiles p
    WHERE p.organization_id = p_organization_id AND p.reporting_engineer_id = p_leader_user_id
      AND COALESCE(p.is_active, true) = true
    UNION ALL
    SELECT p.user_id FROM public.profiles p INNER JOIN subtree s ON p.reporting_engineer_id = s.user_id
    WHERE p.organization_id = p_organization_id AND COALESCE(p.is_active, true) = true
  )
  SELECT subtree.user_id FROM subtree;
$$;

-- the row engine is worker-only in production; a stub is enough for scope tests
CREATE FUNCTION public.report_daily_project_rows_v1(
  p_organization_id uuid, p_cfg jsonb, p_from date, p_to date, p_user_id uuid, p_user_ids uuid[],
  p_snapshot timestamptz, p_cursor jsonb, p_page_size integer, p_x boolean
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('user_ids', to_jsonb(p_user_ids), 'user_id', p_user_id)
$$;

-- ---- seed -------------------------------------------------------------------
DO $s$
DECLARE
  pat uuid := gen_random_uuid(); ml uuid := gen_random_uuid();
  p_adm uuid := gen_random_uuid(); p_mgr uuid := gen_random_uuid(); p_mgr2 uuid := gen_random_uuid(); p_emp uuid := gen_random_uuid();
  m_adm uuid := gen_random_uuid(); m_mgr uuid := gen_random_uuid(); m_exec uuid := gen_random_uuid();
  m_s1 uuid := gen_random_uuid(); m_s2 uuid := gen_random_uuid(); m_s3 uuid := gen_random_uuid(); m_other uuid := gen_random_uuid();
  u uuid;
BEGIN
  INSERT INTO public.organizations(id, name) VALUES (pat, 'Patidar Travels'), (ml, 'MicroLink');
  INSERT INTO public.organization_features VALUES (pat, 'teams_enabled', true), (ml, 'approval_hierarchy', true);

  -- Patidar: admin, 2 managers, 1 employee; NO reporting links, NO teams
  INSERT INTO public.organization_memberships(user_id, organization_id, role) VALUES
    (p_adm, pat, 'admin'), (p_mgr, pat, 'engineer'), (p_mgr2, pat, 'engineer'), (p_emp, pat, 'employee');
  -- MicroLink: admin, manager (s1,s2 direct; s3 under s1), executive, other employee
  INSERT INTO public.organization_memberships(user_id, organization_id, role) VALUES
    (m_adm, ml, 'admin'), (m_mgr, ml, 'engineer'), (m_exec, ml, 'executive'),
    (m_s1, ml, 'employee'), (m_s2, ml, 'employee'), (m_s3, ml, 'employee'), (m_other, ml, 'employee');

  FOREACH u IN ARRAY ARRAY[p_adm, p_mgr, p_mgr2, p_emp] LOOP
    INSERT INTO public.profiles(user_id, organization_id, name, email) VALUES (u, pat, 'u-' || left(u::text, 4), 'x@pat');
    INSERT INTO auth.users(id, email) VALUES (u, 'x@pat');
  END LOOP;
  FOREACH u IN ARRAY ARRAY[m_adm, m_mgr, m_exec, m_s1, m_s2, m_s3, m_other] LOOP
    INSERT INTO public.profiles(user_id, organization_id, name, email) VALUES (u, ml, 'u-' || left(u::text, 4), 'x@ml');
    INSERT INTO auth.users(id, email) VALUES (u, 'x@ml');
  END LOOP;
  UPDATE public.profiles SET reporting_engineer_id = m_mgr WHERE user_id IN (m_s1, m_s2);
  UPDATE public.profiles SET reporting_engineer_id = m_s1 WHERE user_id = m_s3;
  UPDATE public.profiles SET reporting_engineer_id = m_exec WHERE user_id = m_mgr;

  FOREACH u IN ARRAY ARRAY[p_adm, p_mgr, p_mgr2, p_emp, m_mgr, m_exec, m_s1, m_s2, m_s3, m_other] LOOP
    INSERT INTO public.expenses(organization_id, user_id, title, total_amount)
    VALUES (CASE WHEN u IN (p_adm, p_mgr, p_mgr2, p_emp) THEN pat ELSE ml END, u, 'e1', 100),
           (CASE WHEN u IN (p_adm, p_mgr, p_mgr2, p_emp) THEN pat ELSE ml END, u, 'e2', 200);
  END LOOP;
END
$s$;
