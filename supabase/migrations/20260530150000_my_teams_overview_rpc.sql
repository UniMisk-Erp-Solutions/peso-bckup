-- My Teams dashboard RPCs + gate manager team visibility on teams_enabled.

CREATE OR REPLACE FUNCTION public.org_feature_enabled(
  p_organization_id uuid,
  p_feature_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_features ofe
    WHERE ofe.organization_id = p_organization_id
      AND ofe.feature_key = p_feature_key
      AND ofe.enabled = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.org_feature_enabled(uuid, text) TO authenticated;

-- Re-create manager visibility with teams_enabled gate on team_members branch.
CREATE OR REPLACE FUNCTION public.manager_expense_visible_to_user(
  e public.expenses,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_user_id IS NOT NULL
    AND (
      e.assigned_engineer_id = p_user_id
      OR e.assigned_reviewer_id = p_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = p_user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles emp
        JOIN public.profiles sup
          ON sup.user_id = emp.reporting_engineer_id
         AND sup.organization_id = emp.organization_id
        WHERE emp.user_id = e.user_id
          AND emp.organization_id = e.organization_id
          AND (
            emp.reporting_engineer_id = p_user_id
            OR sup.reporting_engineer_id = p_user_id
          )
      )
      OR (
        public.org_feature_enabled(e.organization_id, 'teams_enabled')
        AND EXISTS (
          SELECT 1
          FROM public.team_members tm
          JOIN public.teams t
            ON t.id = tm.team_id
           AND t.organization_id = tm.organization_id
          WHERE tm.user_id = e.user_id
            AND tm.organization_id = e.organization_id
            AND t.manager_user_id = p_user_id
        )
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.user_is_team_leader(
  p_team_id uuid,
  p_organization_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.teams t
    WHERE t.id = p_team_id
      AND t.organization_id = p_organization_id
      AND (
        t.team_leader_user_id = p_user_id
        OR t.executive_user_id = p_user_id
        OR t.manager_user_id = p_user_id
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_is_team_leader(uuid, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_my_teams_overview(
  p_organization_id uuid,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_teams jsonb := '[]'::jsonb;
  v_team record;
  v_members jsonb;
  v_roles text[];
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL THEN
    RETURN jsonb_build_object('teams', '[]'::jsonb);
  END IF;

  IF NOT public.org_feature_enabled(p_organization_id, 'teams_enabled') THEN
    RETURN jsonb_build_object('teams', '[]'::jsonb);
  END IF;

  SELECT om.role INTO v_role
  FROM public.organization_memberships om
  WHERE om.organization_id = p_organization_id
    AND om.user_id = v_uid
    AND om.is_active = true
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('teams', '[]'::jsonb);
  END IF;

  IF v_role NOT IN ('admin', 'engineer', 'team_leader', 'executive') THEN
    RETURN jsonb_build_object('teams', '[]'::jsonb);
  END IF;

  FOR v_team IN
    SELECT
      t.id,
      t.name,
      t.routing_mode,
      t.team_leader_user_id,
      t.executive_user_id,
      t.manager_user_id,
      tl.name AS team_leader_name,
      ex.name AS executive_name,
      mgr.name AS manager_name
    FROM public.teams t
    LEFT JOIN public.profiles tl
      ON tl.user_id = t.team_leader_user_id
     AND tl.organization_id = t.organization_id
    LEFT JOIN public.profiles ex
      ON ex.user_id = t.executive_user_id
     AND ex.organization_id = t.organization_id
    LEFT JOIN public.profiles mgr
      ON mgr.user_id = t.manager_user_id
     AND mgr.organization_id = t.organization_id
    WHERE t.organization_id = p_organization_id
      AND (
        v_role = 'admin'
        OR t.team_leader_user_id = v_uid
        OR t.executive_user_id = v_uid
        OR t.manager_user_id = v_uid
      )
    ORDER BY t.name
  LOOP
    v_roles := ARRAY[]::text[];
    IF v_team.team_leader_user_id = v_uid THEN
      v_roles := array_append(v_roles, 'team_leader');
    END IF;
    IF v_team.executive_user_id = v_uid THEN
      v_roles := array_append(v_roles, 'executive');
    END IF;
    IF v_team.manager_user_id = v_uid THEN
      v_roles := array_append(v_roles, 'manager');
    END IF;

    IF v_role = 'admin' THEN
      v_roles := ARRAY['admin'];
    ELSIF cardinality(v_roles) = 0 THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'user_id', p.user_id,
          'name', COALESCE(p.name, ''),
          'email', COALESCE(p.email, ''),
          'employee_id', COALESCE(p.employee_id, ''),
          'balance', COALESCE(p.balance, 0),
          'pending_expense_count', COALESCE(pend.cnt, 0),
          'pending_expense_total', COALESCE(pend.total, 0),
          'approved_expense_count', COALESCE(appr.cnt, 0),
          'approved_expense_total', COALESCE(appr.total, 0)
        )
        ORDER BY p.name
      ),
      '[]'::jsonb
    )
    INTO v_members
    FROM public.team_members tm
    JOIN public.profiles p
      ON p.user_id = tm.user_id
     AND p.organization_id = tm.organization_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS cnt,
        COALESCE(SUM(e.total_amount), 0) AS total
      FROM public.expenses e
      WHERE e.organization_id = p_organization_id
        AND e.user_id = p.user_id
        AND e.status IN (
          'submitted',
          'edited',
          'under_review',
          'level_1_verified',
          'level_2_verified'
        )
    ) pend ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS cnt,
        COALESCE(SUM(e.total_amount), 0) AS total
      FROM public.expenses e
      WHERE e.organization_id = p_organization_id
        AND e.user_id = p.user_id
        AND e.status IN ('verified', 'approved')
        AND (p_date_from IS NULL OR e.created_at >= p_date_from)
        AND (p_date_to IS NULL OR e.created_at <= p_date_to)
    ) appr ON true
    WHERE tm.team_id = v_team.id
      AND tm.organization_id = p_organization_id;

    v_teams := v_teams || jsonb_build_array(
      jsonb_build_object(
        'id', v_team.id,
        'name', v_team.name,
        'routing_mode', v_team.routing_mode,
        'roles_on_team', to_jsonb(v_roles),
        'team_leader_user_id', v_team.team_leader_user_id,
        'executive_user_id', v_team.executive_user_id,
        'manager_user_id', v_team.manager_user_id,
        'team_leader_name', v_team.team_leader_name,
        'executive_name', v_team.executive_name,
        'manager_name', v_team.manager_name,
        'member_count', jsonb_array_length(v_members),
        'members', v_members
      )
    );
  END LOOP;

  RETURN jsonb_build_object('teams', v_teams);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_teams_overview(uuid, timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_team_expenses_for_leader(
  p_organization_id uuid,
  p_team_id uuid,
  p_status_filter text DEFAULT 'all',
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL,
  p_limit int DEFAULT 500,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  expense_id uuid,
  user_id uuid,
  employee_name text,
  employee_id text,
  employee_email text,
  title text,
  total_amount numeric,
  status text,
  created_at timestamptz,
  category_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  IF NOT public.org_feature_enabled(p_organization_id, 'teams_enabled') THEN
    RETURN;
  END IF;

  SELECT om.role INTO v_role
  FROM public.organization_memberships om
  WHERE om.organization_id = p_organization_id
    AND om.user_id = v_uid
    AND om.is_active = true
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN;
  END IF;

  IF v_role NOT IN ('admin', 'engineer', 'team_leader', 'executive') THEN
    RETURN;
  END IF;

  IF v_role <> 'admin'
     AND NOT public.user_is_team_leader(p_team_id, p_organization_id, v_uid) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    e.id AS expense_id,
    e.user_id,
    COALESCE(p.name, '') AS employee_name,
    COALESCE(p.employee_id, '') AS employee_id,
    COALESCE(p.email, '') AS employee_email,
    COALESCE(e.title, '') AS title,
    e.total_amount,
    e.status::text,
    e.created_at,
    COALESCE(c.name, '') AS category_name
  FROM public.expenses e
  JOIN public.team_members tm
    ON tm.user_id = e.user_id
   AND tm.organization_id = e.organization_id
   AND tm.team_id = p_team_id
  JOIN public.profiles p
    ON p.user_id = e.user_id
   AND p.organization_id = e.organization_id
  LEFT JOIN public.categories c ON c.id = e.category_id
  WHERE e.organization_id = p_organization_id
    AND (
      p_status_filter = 'all'
      OR (
        p_status_filter = 'pending'
        AND e.status IN (
          'submitted',
          'edited',
          'under_review',
          'level_1_verified',
          'level_2_verified'
        )
      )
      OR (
        p_status_filter = 'approved'
        AND e.status IN ('verified', 'approved')
      )
    )
    AND (p_date_from IS NULL OR e.created_at >= p_date_from)
    AND (p_date_to IS NULL OR e.created_at <= p_date_to)
  ORDER BY e.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_team_expenses_for_leader(
  uuid, uuid, text, timestamptz, timestamptz, int, int
) TO authenticated;
