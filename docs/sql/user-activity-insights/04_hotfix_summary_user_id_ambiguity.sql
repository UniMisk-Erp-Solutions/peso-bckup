-- ============================================================
-- User Activity Insights — Production Hotfix 04
-- docs/sql/user-activity-insights/04_hotfix_summary_user_id_ambiguity.sql
--
-- Fixes: PostgREST 400 / SQLSTATE 42702
--        "column reference 'user_id' is ambiguous"
--        in get_user_activity_summary
--
-- Root cause:
--   get_user_activity_summary is declared as
--   RETURNS TABLE(user_id uuid, name text, email text, ...).
--   In PL/pgSQL, every column listed in RETURNS TABLE is implicitly
--   declared as an output variable in the function scope. This means
--   names like user_id, name, email, role, employee_id, last_seen_at,
--   first_seen_in_range, today_visible_seconds, today_expenses_submitted
--   are all PL/pgSQL variables in scope throughout the function body.
--
--   Even CTE column references like m.user_id or agg.last_seen_at
--   can trigger error 42702 in some PostgreSQL versions because the
--   parser finds multiple candidates: the table column AND the output
--   variable of the same name.
--
-- Fix:
--   Rename every CTE output column and every JOIN ON reference to a
--   unique alias that does NOT match any RETURNS TABLE output column.
--   The final SELECT then maps the unique aliases back to the declared
--   RETURNS TABLE column order with explicit AS aliases.
--
-- Safe to run:
--   - Only uses CREATE OR REPLACE FUNCTION (idempotent)
--   - No DROP, no ALTER TABLE, no CREATE TABLE, no CREATE POLICY
--   - No CREATE TRIGGER, no INSERT, no UPDATE, no DELETE
--   - No changes to expenses, RLS, or expense submission logic
--   - Safe to run after Hotfix 03 (03_hotfix_app_role_enum_casts.sql)
--   - All Hotfix 03 enum casts (role::text) are preserved and extended
--
-- Run order:
--   1. 03_hotfix_app_role_enum_casts.sql  (fixes app_role enum error)
--   2. This file (04_hotfix_summary_user_id_ambiguity.sql)
--   3. Hard refresh the app
--   4. Verify with 05_verify_summary_rpc_after_hotfix.sql
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id  uuid;
  v_org_id     uuid;
  v_today      date    := current_date;
  v_range_days integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- om_admin alias prevents user_id output-variable ambiguity in WHERE clause.
  -- role::text cast preserves Hotfix 03 fix for app_role enum comparison.
  SELECT om_admin.organization_id
  INTO   v_org_id
  FROM   public.organization_memberships om_admin
  WHERE  om_admin.user_id    = v_caller_id
    AND  om_admin.role::text = 'admin'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Only org admins can view activity summaries.';
  END IF;

  IF NOT public.is_user_activity_insights_enabled(v_org_id) THEN
    RETURN;
  END IF;

  v_range_days := (p_end_date - p_start_date) + 1;

  RETURN QUERY
  WITH
    -- ── members ────────────────────────────────────────────────────
    -- All org members excluding master_admin.
    -- Every output column is renamed with a unique prefix (member_)
    -- so no CTE column name matches a RETURNS TABLE output variable.
    members AS (
      SELECT
        om_member.user_id              AS member_user_id,
        p_member.name             AS member_name,
        au_member.email                AS member_email,
        p_member.employee_id           AS member_employee_id,
        -- role is app_role enum; ::text cast from Hotfix 03
        om_member.role::text           AS member_role
      FROM   public.organization_memberships om_member
      JOIN   public.profiles   p_member  ON p_member.user_id  = om_member.user_id
      JOIN   auth.users        au_member ON au_member.id       = om_member.user_id
      WHERE  om_member.organization_id  = v_org_id
        -- role is app_role enum; ::text cast from Hotfix 03
        AND  om_member.role::text      <> 'master_admin'
    ),

    -- ── range_rollups ───────────────────────────────────────────────
    -- Rollup rows in the requested date range for this org.
    -- Unique prefix (rollup_) avoids collisions with RETURNS TABLE vars.
    range_rollups AS (
      SELECT
        rr.user_id                     AS rollup_user_id,
        rr.activity_date               AS rollup_activity_date,
        rr.visible_seconds             AS rollup_visible_seconds,
        rr.expenses_submitted_count    AS rollup_expenses_submitted_count,
        rr.first_seen_at               AS rollup_first_seen_at,
        rr.last_seen_at                AS rollup_last_seen_at
      FROM   public.user_activity_daily_rollups rr
      WHERE  rr.organization_id = v_org_id
        AND  rr.activity_date   BETWEEN p_start_date AND p_end_date
    ),

    -- ── agg ─────────────────────────────────────────────────────────
    -- Per-user aggregates over the range.
    -- Unique prefix (agg_) avoids collisions with RETURNS TABLE vars.
    agg AS (
      SELECT
        rr.rollup_user_id                                  AS agg_user_id,
        MAX(rr.rollup_last_seen_at)                        AS agg_last_seen_at,
        MIN(rr.rollup_first_seen_at)                       AS agg_first_seen_in_range,
        SUM(rr.rollup_visible_seconds)::integer            AS agg_total_visible_seconds,
        SUM(rr.rollup_expenses_submitted_count)::integer   AS agg_total_expenses_submitted,
        COUNT(DISTINCT rr.rollup_activity_date)::integer   AS agg_active_days,
        MAX(rr.rollup_last_seen_at)                        AS agg_last_active_at
      FROM   range_rollups rr
      GROUP  BY rr.rollup_user_id
    ),

    -- ── today_agg ───────────────────────────────────────────────────
    -- Today's rollup row per user.
    -- Unique suffix (_value) avoids collisions with RETURNS TABLE vars
    -- today_visible_seconds and today_expenses_submitted.
    today_agg AS (
      SELECT
        td.user_id                     AS today_user_id,
        td.visible_seconds             AS today_visible_seconds_value,
        td.expenses_submitted_count    AS today_expenses_submitted_value
      FROM   public.user_activity_daily_rollups td
      WHERE  td.organization_id = v_org_id
        AND  td.activity_date   = v_today
    )

  -- ── final SELECT ─────────────────────────────────────────────────
  -- Explicit AS aliases map unique CTE names back to RETURNS TABLE
  -- column order. Every column name matches the declared RETURNS TABLE
  -- signature exactly so PostgREST can bind the result set correctly.
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
    (v_range_days - COALESCE(a.agg_active_days, 0))::integer   AS inactive_days,
    CASE
      WHEN a.agg_last_active_at IS NULL THEN v_range_days
      ELSE (p_end_date - a.agg_last_active_at::date)
    END::integer                                               AS current_inactive_streak,
    COALESCE(a.agg_total_visible_seconds,      0)::integer     AS total_visible_seconds,
    COALESCE(a.agg_total_expenses_submitted,   0)::integer     AS total_expenses_submitted
  FROM       members      m
  LEFT JOIN  agg      a   ON a.agg_user_id   = m.member_user_id
  LEFT JOIN  today_agg t  ON t.today_user_id = m.member_user_id
  ORDER BY   COALESCE(a.agg_last_seen_at, '1970-01-01'::timestamptz) DESC;

END;
$$;

COMMENT ON FUNCTION public.get_user_activity_summary IS
  'Returns one row per org member with activity stats for the date range. '
  'Set-based join on rollups — no per-user loops. Admin-only. '
  'Hotfix 03: role::text casts to avoid app_role enum error on master_admin. '
  'Hotfix 04: all CTE columns use unique prefixes (member_, agg_, rollup_, '
  'today_*_value) to eliminate SQLSTATE 42702 ambiguity with RETURNS TABLE '
  'output variables (user_id, name, email, role, last_seen_at, etc.).';
