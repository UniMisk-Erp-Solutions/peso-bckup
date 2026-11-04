-- Secure, server-derived report scope (DOC-147).
--
-- PROBLEM: the team/self report RPCs authorized the CALLER'S ROLE but trusted a
-- client-supplied user-id list (p_user_ids). get_team_expenses_for_members and
-- get_expense_submitter_profiles were also executable by anon. A browser could
-- therefore request any employee in any organization.
--
-- FIX: scope is derived from auth.uid() on the server:
--   employee/other member    -> [self]
--   engineer/TL/executive    -> self + formal-team members they lead (teams_enabled)
--                               + reporting-chain subordinates (teams_enabled or
--                               approval_hierarchy)
--   admin                    -> every profile in the organization
-- Requested ids are INTERSECTED with that scope; an empty/NULL request means "the
-- whole scope". No approval-routing function or flag is touched.
--
-- Additive: CREATE OR REPLACE with unchanged signatures; grants tightened.

CREATE OR REPLACE FUNCTION public.get_my_report_scope_v1(p_organization_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_role  text;
  v_teams boolean;
  v_hier  boolean;
  v_ids   uuid[];
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  SELECT m.role::text INTO v_role
  FROM public.organization_memberships m
  WHERE m.user_id = v_uid
    AND m.organization_id = p_organization_id
    AND m.is_active = true
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  IF v_role = 'admin' THEN
    SELECT array_agg(DISTINCT x) INTO v_ids
    FROM (
      SELECT v_uid AS x
      UNION
      SELECT p.user_id FROM public.profiles p WHERE p.organization_id = p_organization_id
    ) q
    WHERE x IS NOT NULL;
    RETURN COALESCE(v_ids, ARRAY[v_uid]);
  END IF;

  IF v_role NOT IN ('engineer', 'team_leader', 'executive') THEN
    RETURN ARRAY[v_uid];
  END IF;

  v_teams := public.org_feature_enabled(p_organization_id, 'teams_enabled');
  v_hier  := public.org_feature_enabled(p_organization_id, 'approval_hierarchy');
  IF NOT v_teams AND NOT v_hier THEN
    RETURN ARRAY[v_uid];
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids
  FROM (
    SELECT v_uid AS x
    UNION
    SELECT tm.user_id
    FROM public.teams t
    JOIN public.team_members tm
      ON tm.team_id = t.id AND tm.organization_id = t.organization_id
    WHERE v_teams
      AND t.organization_id = p_organization_id
      AND (t.team_leader_user_id = v_uid
           OR t.executive_user_id = v_uid
           OR t.manager_user_id = v_uid)
    UNION
    SELECT s.user_id
    FROM public.get_subordinate_user_ids(p_organization_id, v_uid) s
  ) q
  WHERE x IS NOT NULL
    AND (x = v_uid OR EXISTS (
      SELECT 1 FROM public.profiles pp
      WHERE pp.user_id = x AND pp.organization_id = p_organization_id));

  RETURN COALESCE(v_ids, ARRAY[v_uid]);
END;
$fn$;


CREATE OR REPLACE FUNCTION public.get_team_expenses_for_members(p_organization_id uuid, p_user_ids uuid[], p_statuses text[] DEFAULT NULL::text[], p_category text DEFAULT NULL::text, p_trip_start_from text DEFAULT NULL::text, p_trip_start_to text DEFAULT NULL::text, p_sort_by text DEFAULT 'created_at'::text, p_limit integer DEFAULT 2000)
 RETURNS TABLE(id uuid, user_id uuid, title text, total_amount numeric, status text, created_at timestamp with time zone, trip_start text, trip_end text, category text, purpose text, destination text, transaction_number text, batch_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

  SELECT

    e.id,

    e.user_id,

    COALESCE(e.title, '')              AS title,

    COALESCE(e.total_amount, 0)        AS total_amount,

    e.status::text                     AS status,

    e.created_at,

    e.trip_start::text                 AS trip_start,

    e.trip_end::text                   AS trip_end,

    COALESCE(e.category, '')           AS category,

    COALESCE(e.purpose, '')            AS purpose,

    COALESCE(e.destination, '')        AS destination,

    COALESCE(e.transaction_number, '') AS transaction_number,

    e.batch_id

  FROM public.expenses e

  WHERE e.organization_id = p_organization_id

    AND e.user_id = ANY(p_user_ids)
    -- Server-derived scope is the boundary; p_user_ids can only narrow it.
    AND e.user_id = ANY(public.get_my_report_scope_v1(p_organization_id))

    AND (p_statuses IS NULL OR e.status::text = ANY(p_statuses))

    AND (p_category IS NULL OR e.category ILIKE p_category)

    AND (p_trip_start_from IS NULL OR e.trip_start::text >= p_trip_start_from)

    AND (p_trip_start_to   IS NULL OR e.trip_start::text <= p_trip_start_to)

  ORDER BY

    CASE WHEN p_sort_by = 'trip_start' THEN e.trip_start::text END DESC NULLS LAST,

    CASE WHEN p_sort_by IS DISTINCT FROM 'trip_start' THEN e.created_at END DESC NULLS LAST

  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 2000), 5000));

$function$;

CREATE OR REPLACE FUNCTION public.get_expense_submitter_profiles(p_organization_id uuid, p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, name text, email text, balance numeric, employee_id text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

  SELECT

    uid AS user_id,

    CASE

      WHEN COALESCE(p.is_active, true) = false AND p.name IS NOT NULL THEN p.name || ' (Former)'

      ELSE COALESCE(

        p.name,

        mapped.name,

        nullif(trim(au.raw_user_meta_data->>'name'), ''),

        nullif(trim(au.raw_user_meta_data->>'full_name'), ''),

        initcap(replace(split_part(au.email, '@', 1), '.', ' '))

      )

    END AS name,

    COALESCE(p.email, mapped.email, au.email, '') AS email,

    COALESCE(p.balance, mapped.balance, 0::numeric) AS balance,

    COALESCE(

      nullif(trim(p.employee_id), ''),

      nullif(trim(mapped.employee_id), ''),

      nullif(trim(substring(au.email from 'emp\.[^.]+\.([^.]+)\.')), '')

    ) AS employee_id

  FROM unnest(COALESCE(p_user_ids, ARRAY[]::uuid[])) AS uid

  LEFT JOIN public.profiles p

    ON p.user_id = uid

   AND p.organization_id = p_organization_id

  LEFT JOIN auth.users au ON au.id = uid

  LEFT JOIN LATERAL (

    SELECT p2.name, p2.email, p2.balance, p2.employee_id

    FROM public.profiles p2

    WHERE p2.organization_id = p_organization_id

      AND p2.employee_id IS NOT NULL

      AND trim(p2.employee_id) <> ''

      AND lower(trim(p2.employee_id)) = lower(

        substring(au.email from 'emp\.[^.]+\.([^.]+)\.')

      )

    LIMIT 1

  ) mapped ON p.user_id IS NULL
  WHERE auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.organization_memberships cm
        WHERE cm.user_id = auth.uid()
          AND cm.organization_id = p_organization_id
          AND cm.is_active = true
      )
      OR COALESCE((SELECT pr.is_master_admin FROM public.profiles pr WHERE pr.user_id = auth.uid() LIMIT 1), false)
    )
    AND (
      p.user_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.organization_memberships om
                 WHERE om.user_id = uid AND om.organization_id = p_organization_id)
      OR EXISTS (SELECT 1 FROM public.expenses ex
                 WHERE ex.user_id = uid AND ex.organization_id = p_organization_id)
    )

$function$;

CREATE OR REPLACE FUNCTION public.daily_report_caller_can_view_v1(p_organization_id uuid, p_team_scoped boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (
      SELECT CASE
        WHEN p_team_scoped THEN
          m.role::text IN ('admin', 'engineer', 'team_leader', 'executive')
          -- Employee self-report: own data only (scope enforced by get_my_report_scope_v1).
          OR (m.role::text = 'employee'
              AND public.org_feature_enabled(p_organization_id, 'teams_enabled'))
        ELSE
          m.role::text = 'admin'
          OR (
            COALESCE(m.is_accountant_cashier, false)
            AND EXISTS (
              SELECT 1 FROM public.organization_features f
              WHERE f.organization_id = p_organization_id
                AND f.feature_key = 'cashier_accountant_mode'
                AND f.enabled = true
            )
          )
      END
      FROM public.organization_memberships m
      WHERE m.user_id = auth.uid()
        AND m.organization_id = p_organization_id
        AND m.is_active = true
      LIMIT 1
    ),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.get_daily_project_report_page_v1(p_organization_id uuid, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_user_id uuid DEFAULT NULL::uuid, p_user_ids uuid[] DEFAULT NULL::uuid[], p_team_scoped boolean DEFAULT false, p_snapshot_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor jsonb DEFAULT NULL::jsonb, p_page_size integer DEFAULT 250)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg jsonb;
  v_scope uuid[];
  v_user_ids uuid[] := p_user_ids;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, COALESCE(p_team_scoped, false)) THEN
    RAISE EXCEPTION 'not permitted to generate this report' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(p_team_scoped, false) THEN
    v_scope := public.get_my_report_scope_v1(p_organization_id);
    IF p_user_id IS NOT NULL AND NOT (p_user_id = ANY(v_scope)) THEN
      RAISE EXCEPTION 'requested user is outside your report scope' USING ERRCODE = '42501';
    END IF;
    IF p_user_ids IS NULL OR cardinality(p_user_ids) = 0 THEN
      v_user_ids := v_scope;
    ELSE
      v_user_ids := ARRAY(SELECT u FROM unnest(p_user_ids) AS u WHERE u = ANY(v_scope));
      IF cardinality(v_user_ids) = 0 THEN
        RAISE EXCEPTION 'requested users are outside your report scope' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) INTO v_cfg
  FROM public.organization_settings s
  WHERE s.organization_id = p_organization_id;

  RETURN public.report_daily_project_rows_v1(
    p_organization_id, COALESCE(v_cfg, '{}'::jsonb),
    p_date_from, p_date_to, p_user_id, v_user_ids,
    p_snapshot_at, p_cursor, LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 500), NULL
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_daily_project_report_export_job_v1(p_organization_id uuid, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_user_id uuid DEFAULT NULL::uuid, p_team_scoped boolean DEFAULT false, p_user_ids uuid[] DEFAULT NULL::uuid[], p_format text DEFAULT 'xlsx'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_team     boolean := COALESCE(p_team_scoped, false);
  v_format   text := lower(COALESCE(p_format, 'xlsx'));
  v_config   jsonb;
  v_params   jsonb;
  v_dedupe   text;
  v_existing public.report_export_jobs%ROWTYPE;
  v_job_id   uuid;
  v_scope    uuid[];
  v_user_ids uuid[] := p_user_ids;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF v_format NOT IN ('xlsx', 'csv') THEN
    RAISE EXCEPTION 'unsupported format' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NOT NULL AND p_date_to IS NOT NULL AND p_date_from > p_date_to THEN
    RAISE EXCEPTION 'date range is inverted' USING ERRCODE = '22023';
  END IF;

  -- Permission is resolved from auth.uid(), never from anything the client
  -- sent -- same check the browser-path get_daily_project_report_page_v1 uses.
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, v_team) THEN
    RAISE EXCEPTION 'not permitted to generate this report' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(v_team, false) THEN
    v_scope := public.get_my_report_scope_v1(p_organization_id);
    IF p_user_id IS NOT NULL AND NOT (p_user_id = ANY(v_scope)) THEN
      RAISE EXCEPTION 'requested user is outside your report scope' USING ERRCODE = '42501';
    END IF;
    IF p_user_ids IS NULL OR cardinality(p_user_ids) = 0 THEN
      v_user_ids := v_scope;
    ELSE
      v_user_ids := ARRAY(SELECT u FROM unnest(p_user_ids) AS u WHERE u = ANY(v_scope));
      IF cardinality(v_user_ids) = 0 THEN
        RAISE EXCEPTION 'requested users are outside your report scope' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- Freeze the org's project/category field-mapping config now, so a later
  -- admin change to it can never retroactively alter an already-enqueued (or
  -- already-completed) export -- same source get_daily_project_report_page_v1
  -- reads for the equivalent browser-driven page.
  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) INTO v_config
  FROM public.organization_settings s
  WHERE s.organization_id = p_organization_id;
  v_config := COALESCE(v_config, '{}'::jsonb);

  v_params := jsonb_build_object(
    'date_from', p_date_from,
    'date_to', p_date_to,
    'user_id', p_user_id,
    'user_ids', v_user_ids
  );

  -- Per-user dedupe (the requester IS part of the key): two people asking for
  -- the same daily report each get their own job, matching the
  -- already-documented, never-implemented intent in
  -- 20260827170000_server_side_expense_reports.sql's file header.
  v_dedupe := md5(
    p_organization_id::text || '|daily_project_report|' || v_uid::text || '|' ||
    v_format || '|' || v_params::text || '|' || v_config::text || '|' || v_team::text
  );

  SELECT * INTO v_existing
  FROM public.report_export_jobs
  WHERE dedupe_key = v_dedupe AND status IN ('queued', 'running')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('job_id', v_existing.id, 'status', v_existing.status, 'deduplicated', true);
  END IF;

  INSERT INTO public.report_export_jobs (
    organization_id, requested_by, report_type, format, parameters, config_snapshot, dedupe_key, status
  ) VALUES (
    p_organization_id, v_uid, 'daily_project_report', v_format, v_params, v_config, v_dedupe, 'queued'
  )
  RETURNING id INTO v_job_id;

  RETURN jsonb_build_object('job_id', v_job_id, 'status', 'queued', 'deduplicated', false);
EXCEPTION
  -- Lost a race against a concurrent identical enqueue: return the winner.
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM public.report_export_jobs
    WHERE dedupe_key = v_dedupe AND status IN ('queued', 'running')
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('job_id', v_existing.id, 'status', v_existing.status, 'deduplicated', true);
    END IF;
    RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_expense_report_export_job_v1(p_organization_id uuid, p_report_type text, p_filters jsonb DEFAULT '{}'::jsonb, p_team_scoped boolean DEFAULT false, p_format text DEFAULT 'csv'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dedupe   text;
  v_existing public.report_export_jobs%ROWTYPE;
  v_job_id   uuid;
  v_params   jsonb;
  v_scope    uuid[];
  v_role     text;
  v_req      uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_report_type NOT IN ('claim_verification', 'claim_approval', 'detailed_expense', 'full_expense_detail') THEN
    RAISE EXCEPTION 'unsupported report type: %', p_report_type USING ERRCODE = '22023';
  END IF;
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, COALESCE(p_team_scoped, false)) THEN
    RAISE EXCEPTION 'not permitted to generate this report' USING ERRCODE = '42501';
  END IF;

  v_params := COALESCE(p_filters, '{}'::jsonb);

  IF COALESCE(p_team_scoped, false) THEN
    v_scope := public.get_my_report_scope_v1(p_organization_id);
    SELECT m.role::text INTO v_role
    FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.organization_id = p_organization_id AND m.is_active = true
    LIMIT 1;
    IF v_role = 'employee' AND p_report_type NOT IN ('detailed_expense', 'full_expense_detail') THEN
      RAISE EXCEPTION 'this report is not available for your role' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(v_params->>'user_id', '') IS NOT NULL
       AND NOT ((v_params->>'user_id')::uuid = ANY(v_scope)) THEN
      RAISE EXCEPTION 'requested user is outside your report scope' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(v_params->'user_ids') = 'array' AND jsonb_array_length(v_params->'user_ids') > 0 THEN
      v_req := ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_params->'user_ids') AS t(x));
      v_req := ARRAY(SELECT u FROM unnest(v_req) AS u WHERE u = ANY(v_scope));
      IF cardinality(v_req) = 0 THEN
        RAISE EXCEPTION 'requested users are outside your report scope' USING ERRCODE = '42501';
      END IF;
    ELSE
      v_req := v_scope;
    END IF;
    v_params := jsonb_set(v_params, '{user_ids}', to_jsonb(v_req), true);
  END IF;
  v_dedupe := md5(p_organization_id::text || '|' || p_report_type || '|' || p_format || '|' || v_params::text);

  SELECT * INTO v_existing
  FROM public.report_export_jobs
  WHERE dedupe_key = v_dedupe AND status IN ('queued', 'running')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('job_id', v_existing.id, 'status', v_existing.status, 'deduplicated', true);
  END IF;

  INSERT INTO public.report_export_jobs (
    organization_id, requested_by, report_type, format, parameters,
    config_snapshot, dedupe_key, status
  ) VALUES (
    p_organization_id, auth.uid(), p_report_type, p_format, v_params,
    '{}'::jsonb, v_dedupe, 'queued'
  )
  RETURNING id INTO v_job_id;

  RETURN jsonb_build_object('job_id', v_job_id, 'status', 'queued', 'deduplicated', false);
END;
$function$;

-- Grants: authenticated + service_role only. PUBLIC must be revoked as well as
-- anon (anon inherits PUBLIC); none of these has an anonymous caller.
DO $g$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'public.get_my_report_scope_v1(uuid)',
    'public.get_team_expenses_for_members(uuid, uuid[], text[], text, text, text, text, integer)',
    'public.get_expense_submitter_profiles(uuid, uuid[])',
    'public.daily_report_caller_can_view_v1(uuid, boolean)',
    'public.get_daily_project_report_page_v1(uuid, date, date, uuid, uuid[], boolean, timestamp with time zone, jsonb, integer)',
    'public.create_daily_project_report_export_job_v1(uuid, date, date, uuid, boolean, uuid[], text)',
    'public.create_expense_report_export_job_v1(uuid, text, jsonb, boolean, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r);
  END LOOP;
END
$g$;
