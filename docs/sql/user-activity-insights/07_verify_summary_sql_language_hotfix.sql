-- ============================================================
-- User Activity Insights — Verification after Hotfix 05
-- docs/sql/user-activity-insights/07_verify_summary_sql_language_hotfix.sql
--
-- READ-ONLY. No destructive SQL in this file.
-- Run after: 06_hotfix_summary_sql_language_function.sql
--
-- Browser verification steps (run first):
--   1. Hard refresh /admin/user-activity (Ctrl+Shift+R)
--   2. Network tab: get_user_activity_summary must return 200
--   3. Network tab: start_user_activity_session must stay 200
--   4. Network tab: record_user_activity_heartbeat must stay 204
--   5. Confirm the activity table renders member rows
-- ============================================================


-- ── Check 1: Confirm function language is sql, not plpgsql ───────────────────
-- Expected:
--   proname             = get_user_activity_summary
--   language            = sql
--   security_definer    = true
--   provolatile         = s  (STABLE)

SELECT p.proname,
       l.lanname   AS language,
       p.provolatile,
       p.prosecdef AS security_definer
FROM   pg_proc     p
JOIN   pg_language l ON l.oid = p.prolang
WHERE  p.proname        = 'get_user_activity_summary'
  AND  p.pronamespace   = (SELECT oid FROM pg_namespace WHERE nspname = 'public');


-- ── Check 2: Confirm function definition contains key identifiers ─────────────
-- Expected: output contains ALL of the following strings:
--   LANGUAGE sql
--   member_user_id
--   agg_user_id
--   today_user_id
--   enabled_org
--   om_admin.role::text = 'admin'
--   om_member.role::text <> 'master_admin'
-- Expected: output does NOT contain:
--   LANGUAGE plpgsql
--   DECLARE
--   RETURN QUERY

SELECT pg_get_functiondef(p.oid)
FROM   pg_proc p
WHERE  p.proname      = 'get_user_activity_summary'
  AND  p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');


-- ── Check 3: Confirm rollup data exists ──────────────────────────────────────
-- Expected: rows present if any employee has been tracked since the migration.
-- If 0 rows: employee tracking may not have run yet for this org,
-- or the feature was just enabled — wait for a heartbeat and retry.

SELECT o.name                               AS org_name,
       r.activity_date,
       r.user_id,
       r.visible_seconds,
       r.session_count,
       r.expenses_submitted_count,
       r.last_seen_at,
       r.updated_at
FROM   public.user_activity_daily_rollups r
JOIN   public.organizations o ON o.id = r.organization_id
WHERE  public.is_user_activity_insights_enabled(o.id) = true
ORDER  BY r.updated_at DESC
LIMIT  20;


-- ── Check 4: Confirm membership rows for enabled org ─────────────────────────
-- Expected: admin member present (role text = 'admin').
-- No master_admin rows expected (filtered by the function).

SELECT o.name            AS org_name,
       p.name       AS member_name,
       om.role::text     AS role,
       au.email
FROM   public.organizations o
JOIN   public.organization_memberships om ON om.organization_id = o.id
JOIN   public.profiles   p  ON p.user_id  = om.user_id
JOIN   auth.users        au ON au.id       = om.user_id
WHERE  public.is_user_activity_insights_enabled(o.id) = true
ORDER  BY o.name, om.role::text;
