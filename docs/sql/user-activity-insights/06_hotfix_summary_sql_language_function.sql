-- ============================================================
-- User Activity Insights — Production Hotfix 05
-- docs/sql/user-activity-insights/06_hotfix_summary_sql_language_function.sql
--
-- Fixes: persistent PostgREST 400 / SQLSTATE 42702
--        in get_user_activity_summary after Hotfix 04
--
-- Root cause:
--   PL/pgSQL RETURNS TABLE output variables (user_id, name, email,
--   role, last_seen_at, first_seen_in_range, today_visible_seconds,
--   today_expenses_submitted …) exist in scope throughout the entire
--   PL/pgSQL function body and conflict with CTE column names of the
--   same identifiers. Renaming CTE columns (Hotfix 04) was not
--   sufficient to eliminate all ambiguity paths in the PostgreSQL
--   planner for this PostgreSQL version.
--
-- Fix:
--   Rewrite get_user_activity_summary as LANGUAGE sql instead of
--   LANGUAGE plpgsql. Pure SQL functions do not have PL/pgSQL
--   output-variable scoping, so RETURNS TABLE column names cannot
--   collide with query identifiers. The class of SQLSTATE 42702
--   errors is eliminated entirely.
--
-- Behaviour changes vs plpgsql version:
--   - Returns EMPTY SET (not an exception) when auth.uid() is null,
--     when caller is not an admin, or when feature is disabled.
--   - The frontend handles an empty array gracefully (shows empty
--     state), so this is safe.
--
-- Safe to run:
--   - Only uses CREATE OR REPLACE FUNCTION (idempotent)
--   - No DROP, no ALTER TABLE, no CREATE TABLE, no CREATE POLICY
--   - No CREATE TRIGGER, no INSERT, no UPDATE, no DELETE
--   - No changes to expenses, RLS, or expense submission logic
--   - Safe to run after: main migration, Hotfix 03, Hotfix 04
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_user_activity_summary(
  p_start_date date,
  p_end_date   date
)
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH
  -- Capture caller identity; returns NULL row when unauthenticated
  caller AS (
    SELECT auth.uid() AS caller_user_id
  ),

  -- Resolve caller's org — only succeeds when caller is an org admin.
  -- role::text cast avoids app_role enum comparison error (Hotfix 03).
  -- Returns no rows when caller is not admin → all downstream CTEs empty.
  admin_org AS (
    SELECT om_admin.organization_id AS admin_org_id
    FROM   public.organization_memberships AS om_admin
    JOIN   caller c ON c.caller_user_id = om_admin.user_id
    WHERE  om_admin.role::text = 'admin'
    LIMIT  1
  ),

  -- Gate on feature flag — returns no rows when feature is disabled.
  -- All downstream CTEs are empty when this CTE is empty.
  enabled_org AS (
    SELECT ao.admin_org_id
    FROM   admin_org ao
    WHERE  public.is_user_activity_insights_enabled(ao.admin_org_id)
  ),

  -- Scalar date parameters computed once.
  params AS (
    SELECT
      current_date                            AS today_date,
      ((p_end_date - p_start_date) + 1)::integer AS range_days
  ),

  -- All org members excluding master_admin.
  -- Unique prefix member_ on every output column.
  members AS (
    SELECT
      om_member.user_id              AS member_user_id,
      p_member.name                  AS member_name,
      au_member.email                AS member_email,
      p_member.employee_id           AS member_employee_id,
      om_member.role::text           AS member_role
    FROM   enabled_org eo
    JOIN   public.organization_memberships AS om_member
           ON om_member.organization_id = eo.admin_org_id
    JOIN   public.profiles AS p_member
           ON p_member.user_id = om_member.user_id
    JOIN   auth.users AS au_member
           ON au_member.id = om_member.user_id
    WHERE  om_member.role::text <> 'master_admin'
  ),

  -- Daily rollup rows in the requested date range.
  -- Unique prefix rollup_ on every output column.
  range_rollups AS (
    SELECT
      rollup.user_id                  AS rollup_user_id,
      rollup.activity_date            AS rollup_activity_date,
      rollup.visible_seconds          AS rollup_visible_seconds,
      rollup.expenses_submitted_count AS rollup_expenses_submitted_count,
      rollup.first_seen_at            AS rollup_first_seen_at,
      rollup.last_seen_at             AS rollup_last_seen_at
    FROM   enabled_org eo
    JOIN   public.user_activity_daily_rollups AS rollup
           ON rollup.organization_id = eo.admin_org_id
    WHERE  rollup.activity_date BETWEEN p_start_date AND p_end_date
  ),

  -- Per-user aggregates over the range.
  -- Unique prefix agg_ on every output column.
  agg AS (
    SELECT
      rr.rollup_user_id                                  AS agg_user_id,
      MAX(rr.rollup_last_seen_at)                        AS agg_last_seen_at,
      MIN(rr.rollup_first_seen_at)                       AS agg_first_seen_in_range,
      COALESCE(SUM(rr.rollup_visible_seconds), 0)::integer
                                                         AS agg_total_visible_seconds,
      COALESCE(SUM(rr.rollup_expenses_submitted_count), 0)::integer
                                                         AS agg_total_expenses_submitted,
      COUNT(DISTINCT rr.rollup_activity_date)::integer   AS agg_active_days,
      MAX(rr.rollup_last_seen_at)                        AS agg_last_active_at
    FROM range_rollups rr
    GROUP BY rr.rollup_user_id
  ),

  -- Today's rollup row per user.
  -- Unique suffix _value to avoid any naming collision.
  today_agg AS (
    SELECT
      today_rollup.user_id                  AS today_user_id,
      today_rollup.visible_seconds          AS today_visible_seconds_value,
      today_rollup.expenses_submitted_count AS today_expenses_submitted_value
    FROM   enabled_org eo
    JOIN   params p ON true
    JOIN   public.user_activity_daily_rollups AS today_rollup
           ON today_rollup.organization_id = eo.admin_org_id
          AND today_rollup.activity_date   = p.today_date
  )

-- Final SELECT: explicit AS aliases map CTE columns to RETURNS TABLE order.
SELECT
  m.member_user_id                                           AS user_id,
  m.member_name                                              AS name,
  m.member_email                                             AS email,
  m.member_employee_id                                       AS employee_id,
  m.member_role                                              AS role,
  a.agg_last_seen_at                                         AS last_seen_at,
  a.agg_first_seen_in_range                                  AS first_seen_in_range,
  COALESCE(t.today_visible_seconds_value,    0)::integer     AS today_visible_seconds,
  COALESCE(t.today_expenses_submitted_value, 0)::integer     AS today_expenses_submitted,
  COALESCE(a.agg_active_days,                0)::integer     AS active_days,
  (p.range_days - COALESCE(a.agg_active_days, 0))::integer   AS inactive_days,
  CASE
    WHEN a.agg_last_active_at IS NULL THEN p.range_days
    ELSE (p_end_date - a.agg_last_active_at::date)
  END::integer                                               AS current_inactive_streak,
  COALESCE(a.agg_total_visible_seconds,      0)::integer     AS total_visible_seconds,
  COALESCE(a.agg_total_expenses_submitted,   0)::integer     AS total_expenses_submitted
FROM       members      m
CROSS JOIN params       p
LEFT JOIN  agg      a   ON a.agg_user_id   = m.member_user_id
LEFT JOIN  today_agg t  ON t.today_user_id = m.member_user_id
ORDER BY   COALESCE(a.agg_last_seen_at, '1970-01-01'::timestamptz) DESC;
$$;

COMMENT ON FUNCTION public.get_user_activity_summary IS
  'Returns one row per org member with activity stats for the date range. '
  'Set-based join on rollups — no per-user loops. Admin-only. '
  'Returns empty set when caller is unauthenticated, not admin, or feature disabled. '
  'Hotfix 03: role::text casts for app_role enum. '
  'Hotfix 04: CTE column renaming. '
  'Hotfix 05: rewritten as LANGUAGE sql to eliminate PL/pgSQL RETURNS TABLE '
  'output-variable ambiguity (SQLSTATE 42702) entirely.';
