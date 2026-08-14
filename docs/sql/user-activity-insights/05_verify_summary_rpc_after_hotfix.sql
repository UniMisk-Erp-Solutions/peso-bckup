-- ============================================================
-- User Activity Insights — Verification after Hotfix 04
-- docs/sql/user-activity-insights/05_verify_summary_rpc_after_hotfix.sql
--
-- READ-ONLY. No destructive SQL in this file.
--
-- Run after: 04_hotfix_summary_user_id_ambiguity.sql
--
-- Purpose: confirm the hotfix was applied and data is flowing correctly.
-- ============================================================


-- ── Check 1: Live function definition ────────────────────────────────────────
-- Expected: output contains member_user_id, agg_user_id, today_user_id,
--           om_admin.user_id, om_admin.role::text = 'admin',
--           om_member.role::text <> 'master_admin'.
-- Expected: output does NOT contain unqualified `WHERE  user_id =`
--           or bare `GROUP BY r.user_id` or `m.user_id` in SELECT.

SELECT pg_get_functiondef(oid)
FROM   pg_proc
WHERE  proname        = 'get_user_activity_summary'
  AND  pronamespace   = (SELECT oid FROM pg_namespace WHERE nspname = 'public');


-- ── Check 2: Feature flag state per org ──────────────────────────────────────
-- Expected: at least one org shows feature_enabled = true (the test org).
-- Replace '%TestOrg%' with any substring of the org name you enabled.

SELECT o.name,
       public.is_user_activity_insights_enabled(o.id) AS feature_enabled
FROM   public.organizations o
ORDER  BY o.name;


-- ── Check 3: Raw rollup rows for the enabled org ─────────────────────────────
-- Expected: rows present if any employee has been tracked since the migration.
-- If no rows: the tracker may not have run yet or the feature was just enabled.

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


-- ── Check 4: Membership rows for all enabled orgs ────────────────────────────
-- Expected: admin member present (role = 'admin'), no master_admin rows.
-- Confirms the summary function can find the caller as admin and will not
-- include master_admin rows in the output.

SELECT o.name                AS org_name,
       p.name           AS member_name,
       om.role::text         AS role,
       au.email
FROM   public.organizations o
JOIN   public.organization_memberships om ON om.organization_id = o.id
JOIN   public.profiles   p  ON p.user_id  = om.user_id
JOIN   auth.users        au ON au.id       = om.user_id
WHERE  public.is_user_activity_insights_enabled(o.id) = true
ORDER  BY o.name, om.role::text;
