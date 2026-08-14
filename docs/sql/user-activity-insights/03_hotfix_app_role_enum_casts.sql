-- ============================================================
-- User Activity Insights — Production Hotfix: app_role enum casts
-- docs/sql/user-activity-insights/03_hotfix_app_role_enum_casts.sql
--
-- PRODUCTION HOTFIX — safe to run after the main migration.
--
-- Problem:
--   start_user_activity_session and get_user_activity_summary both
--   compared organization_memberships.role directly to the string literal
--   'master_admin'. The role column is typed as the app_role enum.
--   PostgreSQL cannot implicitly cast a string literal to an enum value
--   that does not exist in the enum definition, so it throws:
--     invalid input value for enum app_role: "master_admin"
--   This caused a 400 error before either RPC could do any work.
--
-- Fix:
--   Cast role to text before comparing: role::text <> 'master_admin'
--   PostgreSQL can always cast any enum value to text, so this is safe
--   regardless of whether master_admin is in the enum or not.
--
-- Safety:
--   - Only uses CREATE OR REPLACE FUNCTION
--   - Does NOT change any tables, indexes, triggers, or RLS policies
--   - Does NOT touch expenses, expense submission logic, or any other RPC
--   - Safe to run multiple times (idempotent)
--   - The main migration (290713_0900_user_activity_insights.sql) has also
--     been updated with these casts so future fresh installs are correct
--
-- Run order:
--   1. Run this file in the Supabase SQL Editor (production)
--   2. Hard refresh the preview/prod app
--   3. Login as employee — confirm start_user_activity_session no longer 400s
--   4. Login as admin — confirm get_user_activity_summary no longer 400s
-- ============================================================


-- ============================================================
-- Fix 1: start_user_activity_session
-- role::text cast prevents enum comparison error on master_admin
-- ============================================================
CREATE OR REPLACE FUNCTION public.start_user_activity_session(p_user_agent text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    uuid;
  v_org_id     uuid;
  v_session_id uuid;
  v_today      date := current_date;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING HINT = 'User must be signed in to start an activity session.';
  END IF;

  -- role is app_role enum; cast to text before comparing with master_admin
  SELECT organization_id INTO v_org_id
  FROM   public.organization_memberships
  WHERE  user_id    = v_user_id
    AND  role::text <> 'master_admin'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no_organization' USING HINT = 'User has no active organization membership.';
  END IF;

  IF NOT public.is_user_activity_insights_enabled(v_org_id) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.user_activity_sessions (organization_id, user_id, user_agent)
  VALUES (v_org_id, v_user_id, p_user_agent)
  RETURNING id INTO v_session_id;

  INSERT INTO public.user_activity_daily_rollups
    (organization_id, user_id, activity_date, first_seen_at, last_seen_at, session_count)
  VALUES (v_org_id, v_user_id, v_today, now(), now(), 1)
  ON CONFLICT (organization_id, user_id, activity_date) DO UPDATE
    SET first_seen_at = COALESCE(user_activity_daily_rollups.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at  = GREATEST(user_activity_daily_rollups.last_seen_at, EXCLUDED.last_seen_at),
        session_count = user_activity_daily_rollups.session_count + 1,
        updated_at    = now();

  RETURN v_session_id;
END;
$$;

COMMENT ON FUNCTION public.start_user_activity_session IS
  'Inserts a session row and upserts the daily rollup for today. '
  'Returns NULL if the feature is disabled so the client-side tracker can stop quietly. '
  'Uses role::text cast to avoid app_role enum comparison error on master_admin.';


-- ============================================================
-- Fix 2: get_user_activity_summary
-- role::text cast in WHERE and in SELECT column
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_activity_summary(p_start_date date, p_end_date date)
RETURNS TABLE (
  user_id                  uuid,
  name                     text,
  email                    text,
  employee_id              text,
  role                     text,
  last_seen_at             timestamptz,
  first_seen_in_range      timestamptz,
  today_visible_seconds    integer,
  today_expenses_submitted integer,
  active_days              integer,
  inactive_days            integer,
  current_inactive_streak  integer,
  total_visible_seconds    integer,
  total_expenses_submitted integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id  uuid;
  v_org_id     uuid;
  v_today      date := current_date;
  v_range_days integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT organization_id INTO v_org_id
  FROM   public.organization_memberships
  WHERE  user_id = v_caller_id
    AND  role    = 'admin'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING HINT = 'Only org admins can view activity summaries.';
  END IF;

  IF NOT public.is_user_activity_insights_enabled(v_org_id) THEN
    RETURN;
  END IF;

  v_range_days := (p_end_date - p_start_date) + 1;

  RETURN QUERY
  WITH
    -- All active members of the org (excluding master_admin)
    members AS (
      SELECT om.user_id,
             p.name        AS name,
             au.email,
             p.employee_id,
             -- role is app_role enum; cast to text before returning as text column
             om.role::text      AS role
      FROM   public.organization_memberships om
      JOIN   public.profiles p  ON p.user_id = om.user_id
      JOIN   auth.users      au ON au.id      = om.user_id
      WHERE  om.organization_id = v_org_id
        -- role is app_role enum; cast to text before comparing with master_admin
        AND  om.role::text     <> 'master_admin'
    ),
    range_rollups AS (
      SELECT r.user_id, r.activity_date, r.visible_seconds,
             r.expenses_submitted_count, r.first_seen_at, r.last_seen_at
      FROM   public.user_activity_daily_rollups r
      WHERE  r.organization_id = v_org_id
        AND  r.activity_date BETWEEN p_start_date AND p_end_date
    ),
    agg AS (
      SELECT r.user_id,
             MAX(r.last_seen_at)                     AS last_seen_at,
             MIN(r.first_seen_at)                    AS first_seen_in_range,
             SUM(r.visible_seconds)::integer          AS total_visible_seconds,
             SUM(r.expenses_submitted_count)::integer AS total_expenses_submitted,
             COUNT(DISTINCT r.activity_date)::integer AS active_days,
             MAX(r.last_seen_at)                     AS last_active_at
      FROM   range_rollups r
      GROUP  BY r.user_id
    ),
    today_agg AS (
      SELECT r.user_id,
             r.visible_seconds          AS today_visible_seconds,
             r.expenses_submitted_count AS today_expenses_submitted
      FROM   public.user_activity_daily_rollups r
      WHERE  r.organization_id = v_org_id AND r.activity_date = v_today
    )
  SELECT
    m.user_id, m.name, m.email, m.employee_id, m.role,
    agg.last_seen_at, agg.first_seen_in_range,
    COALESCE(ta.today_visible_seconds,    0)::integer,
    COALESCE(ta.today_expenses_submitted, 0)::integer,
    COALESCE(agg.active_days,             0)::integer,
    (v_range_days - COALESCE(agg.active_days, 0))::integer,
    CASE WHEN agg.last_active_at IS NULL THEN v_range_days
         ELSE (p_end_date - agg.last_active_at::date) END::integer,
    COALESCE(agg.total_visible_seconds,    0)::integer,
    COALESCE(agg.total_expenses_submitted, 0)::integer
  FROM       members      m
  LEFT JOIN  agg          ON agg.user_id = m.user_id
  LEFT JOIN  today_agg ta ON ta.user_id  = m.user_id
  ORDER BY   COALESCE(agg.last_seen_at, '1970-01-01'::timestamptz) DESC;
END;
$$;

COMMENT ON FUNCTION public.get_user_activity_summary IS
  'Returns one row per org member with activity stats for the date range. '
  'Set-based join on rollups — no per-user queries. Admin-only. '
  'Uses role::text cast to avoid app_role enum comparison error on master_admin.';
