-- Fix My Teams 400 for executives/managers using supervisor hierarchy.
-- Root cause: get_subordinate_user_ids() returned SETOF uuid (column is not user_id).
-- Also: empty formal teams blocked hierarchy fallback; expense status/category joins hardened.

DROP FUNCTION IF EXISTS public.get_subordinate_user_ids(uuid, uuid);

CREATE FUNCTION public.get_subordinate_user_ids(
  p_organization_id uuid,
  p_leader_user_id uuid
)
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE subtree AS (
    SELECT p.user_id
    FROM public.profiles p
    WHERE p.organization_id = p_organization_id
      AND p.reporting_engineer_id = p_leader_user_id
      AND COALESCE(p.is_active, true) = true
    UNION ALL
    SELECT p.user_id
    FROM public.profiles p
    INNER JOIN subtree s ON p.reporting_engineer_id = s.user_id
    WHERE p.organization_id = p_organization_id
      AND COALESCE(p.is_active, true) = true
  )
  SELECT subtree.user_id FROM subtree;
$$;

GRANT EXECUTE ON FUNCTION public.get_subordinate_user_ids(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.user_has_formal_teams_with_members(
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
    JOIN public.team_members tm
      ON tm.team_id = t.id
     AND tm.organization_id = t.organization_id
    WHERE t.organization_id = p_organization_id
      AND (
        t.team_leader_user_id = p_user_id
        OR t.executive_user_id = p_user_id
        OR t.manager_user_id = p_user_id
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_has_formal_teams_with_members(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_teams_expense_is_pending(p_status public.expense_status)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_status::text NOT IN ('draft', 'verified', 'approved', 'rejected', 'paid');
$$;

CREATE OR REPLACE FUNCTION public.my_teams_expense_is_approved(p_status public.expense_status)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_status::text IN ('verified', 'approved');
$$;

GRANT EXECUTE ON FUNCTION public.my_teams_expense_is_pending(public.expense_status) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_teams_expense_is_approved(public.expense_status) TO authenticated;

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
  v_leader_name text;
  v_sub_count int;
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL THEN
    RETURN jsonb_build_object('teams', '[]'::jsonb);
  END IF;

  IF NOT public.org_feature_enabled(p_organization_id, 'teams_enabled')
     AND NOT public.org_feature_enabled(p_organization_id, 'approval_hierarchy') THEN
    RETURN jsonb_build_object('teams', '[]'::jsonb);
  END IF;

  SELECT om.role::text INTO v_role
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

  IF public.org_feature_enabled(p_organization_id, 'teams_enabled') THEN
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
        SELECT COUNT(*)::int AS cnt, COALESCE(SUM(e.total_amount), 0) AS total
        FROM public.expenses e
        WHERE e.organization_id = p_organization_id
          AND e.user_id = p.user_id
          AND public.my_teams_expense_is_pending(e.status)
      ) pend ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, COALESCE(SUM(e.total_amount), 0) AS total
        FROM public.expenses e
        WHERE e.organization_id = p_organization_id
          AND e.user_id = p.user_id
          AND public.my_teams_expense_is_approved(e.status)
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
          'is_hierarchy_team', false,
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
  END IF;

  IF v_role <> 'admin'
     AND public.org_feature_enabled(p_organization_id, 'approval_hierarchy')
     AND NOT public.user_has_formal_teams_with_members(p_organization_id, v_uid) THEN
    SELECT COUNT(*)::int
    INTO v_sub_count
    FROM public.get_subordinate_user_ids(p_organization_id, v_uid) sub;

    IF v_sub_count > 0 THEN
      SELECT COALESCE(p.name, 'My team')
      INTO v_leader_name
      FROM public.profiles p
      WHERE p.organization_id = p_organization_id
        AND p.user_id = v_uid
      LIMIT 1;

      v_roles := ARRAY[]::text[];
      IF v_role = 'team_leader' THEN
        v_roles := ARRAY['team_leader'];
      ELSIF v_role = 'executive' THEN
        v_roles := ARRAY['executive'];
      ELSIF v_role = 'engineer' THEN
        v_roles := ARRAY['manager'];
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
      FROM public.get_subordinate_user_ids(p_organization_id, v_uid) sub
      JOIN public.profiles p
        ON p.user_id = sub.user_id
       AND p.organization_id = p_organization_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, COALESCE(SUM(e.total_amount), 0) AS total
        FROM public.expenses e
        WHERE e.organization_id = p_organization_id
          AND e.user_id = p.user_id
          AND public.my_teams_expense_is_pending(e.status)
      ) pend ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt, COALESCE(SUM(e.total_amount), 0) AS total
        FROM public.expenses e
        WHERE e.organization_id = p_organization_id
          AND e.user_id = p.user_id
          AND public.my_teams_expense_is_approved(e.status)
          AND (p_date_from IS NULL OR e.created_at >= p_date_from)
          AND (p_date_to IS NULL OR e.created_at <= p_date_to)
      ) appr ON true;

      v_teams := v_teams || jsonb_build_array(
        jsonb_build_object(
          'id', v_uid,
          'name', v_leader_name || ' — direct reports',
          'routing_mode', 'hierarchy',
          'is_hierarchy_team', true,
          'roles_on_team', to_jsonb(v_roles),
          'team_leader_user_id', CASE WHEN v_role = 'team_leader' THEN v_uid ELSE NULL END,
          'executive_user_id', CASE WHEN v_role = 'executive' THEN v_uid ELSE NULL END,
          'manager_user_id', CASE WHEN v_role = 'engineer' THEN v_uid ELSE NULL END,
          'team_leader_name', NULL,
          'executive_name', NULL,
          'manager_name', NULL,
          'member_count', jsonb_array_length(v_members),
          'members', v_members
        )
      );
    END IF;
  END IF;

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
  v_is_formal_team boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  IF NOT public.org_feature_enabled(p_organization_id, 'teams_enabled')
     AND NOT public.org_feature_enabled(p_organization_id, 'approval_hierarchy') THEN
    RETURN;
  END IF;

  SELECT om.role::text INTO v_role
  FROM public.organization_memberships om
  WHERE om.organization_id = p_organization_id
    AND om.user_id = v_uid
    AND om.is_active = true
  LIMIT 1;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'engineer', 'team_leader', 'executive') THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.teams t
    WHERE t.id = p_team_id AND t.organization_id = p_organization_id
  ) INTO v_is_formal_team;

  IF v_is_formal_team THEN
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
      COALESCE(NULLIF(trim(e.category), ''), '') AS category_name
    FROM public.expenses e
    JOIN public.team_members tm
      ON tm.user_id = e.user_id
     AND tm.organization_id = e.organization_id
     AND tm.team_id = p_team_id
    JOIN public.profiles p
      ON p.user_id = e.user_id
     AND p.organization_id = e.organization_id
    WHERE e.organization_id = p_organization_id
      AND (
        p_status_filter = 'all'
        OR (p_status_filter = 'pending' AND public.my_teams_expense_is_pending(e.status))
        OR (p_status_filter = 'approved' AND public.my_teams_expense_is_approved(e.status))
      )
      AND (p_date_from IS NULL OR e.created_at >= p_date_from)
      AND (p_date_to IS NULL OR e.created_at <= p_date_to)
    ORDER BY e.created_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000))
    OFFSET GREATEST(0, COALESCE(p_offset, 0));
    RETURN;
  END IF;

  IF v_role <> 'admin' AND p_team_id <> v_uid THEN
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
    COALESCE(NULLIF(trim(e.category), ''), '') AS category_name
  FROM public.expenses e
  JOIN public.get_subordinate_user_ids(p_organization_id, p_team_id) sub
    ON sub.user_id = e.user_id
  JOIN public.profiles p
    ON p.user_id = e.user_id
   AND p.organization_id = e.organization_id
  WHERE e.organization_id = p_organization_id
    AND (
      p_status_filter = 'all'
      OR (p_status_filter = 'pending' AND public.my_teams_expense_is_pending(e.status))
      OR (p_status_filter = 'approved' AND public.my_teams_expense_is_approved(e.status))
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

COMMENT ON FUNCTION public.list_my_teams_overview(uuid, timestamptz, timestamptz) IS
  'My Teams dashboard: formal teams plus supervisor-hierarchy fallback when no team members assigned.';
