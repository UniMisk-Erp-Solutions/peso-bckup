-- ============================================================
-- User Activity Insights — Installation Verification
-- docs/sql/user-activity-insights/00_verify_installation.sql
--
-- READ-ONLY verification queries.
-- Run AFTER applying supabase/migrations/290713_0900_user_activity_insights.sql
-- in the Supabase SQL Editor (staging only).
--
-- No destructive SQL. No DROP. No ALTER. No INSERT. No UPDATE.
-- ============================================================


-- ── 1. Tables exist ──────────────────────────────────────────────────────────
SELECT table_name, table_type
FROM   information_schema.tables
WHERE  table_schema = 'public'
  AND  table_name   IN ('user_activity_sessions', 'user_activity_daily_rollups')
ORDER  BY table_name;
-- Expected: 2 rows (both tables listed as BASE TABLE)


-- ── 2. Columns on user_activity_sessions ─────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'user_activity_sessions'
ORDER  BY ordinal_position;
-- Expected columns: id, organization_id, user_id, started_at, ended_at,
--   last_seen_at, visible_seconds, heartbeat_count, user_agent,
--   created_at, updated_at


-- ── 3. Columns on user_activity_daily_rollups ────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'user_activity_daily_rollups'
ORDER  BY ordinal_position;
-- Expected columns: id, organization_id, user_id, activity_date,
--   first_seen_at, last_seen_at, visible_seconds, session_count,
--   expenses_submitted_count, created_at, updated_at


-- ── 4. Indexes exist ─────────────────────────────────────────────────────────
SELECT indexname, tablename
FROM   pg_indexes
WHERE  schemaname = 'public'
  AND  indexname  IN (
    'idx_user_activity_sessions_org_user_started',
    'idx_user_activity_sessions_org_last_seen',
    'idx_user_activity_rollups_org_date',
    'idx_user_activity_rollups_org_user_date',
    'idx_user_activity_rollups_org_last_seen'
  )
ORDER  BY indexname;
-- Expected: 5 rows


-- ── 5. Functions / RPCs exist ────────────────────────────────────────────────
SELECT routine_name, routine_type
FROM   information_schema.routines
WHERE  routine_schema = 'public'
  AND  routine_name   IN (
    'is_user_activity_insights_enabled',
    'start_user_activity_session',
    'record_user_activity_heartbeat',
    'end_user_activity_session',
    'get_user_activity_summary',
    'get_user_activity_timeline',
    'get_user_activity_detail'
  )
ORDER  BY routine_name;
-- Expected: 7 rows (all FUNCTION)


-- ── 6. Trigger exists ────────────────────────────────────────────────────────
SELECT trigger_name, event_manipulation, event_object_table, action_timing
FROM   information_schema.triggers
WHERE  trigger_schema      = 'public'
  AND  trigger_name        = 'trg_user_activity_expense_submitted'
  AND  event_object_table  = 'expenses';
-- Expected: 2 rows (one for INSERT, one for UPDATE)


-- ── 7. RLS enabled on both tables ────────────────────────────────────────────
SELECT relname AS table_name,
       relrowsecurity AS rls_enabled
FROM   pg_class
WHERE  relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  AND  relname      IN ('user_activity_sessions', 'user_activity_daily_rollups');
-- Expected: both rows show rls_enabled = true


-- ── 8. RLS policies exist ────────────────────────────────────────────────────
SELECT policyname, tablename, cmd
FROM   pg_policies
WHERE  schemaname = 'public'
  AND  tablename  IN ('user_activity_sessions', 'user_activity_daily_rollups')
ORDER  BY tablename, policyname;
-- Expected: 4 SELECT policies:
--   user_activity_daily_rollups  — Org admins can read activity rollups   (SELECT)
--   user_activity_daily_rollups  — Users can read own activity rollups    (SELECT)
--   user_activity_sessions       — Org admins can read activity sessions  (SELECT)
--   user_activity_sessions       — Users can read own activity sessions   (SELECT)


-- ── 9. Feature flag helper smoke-test ────────────────────────────────────────
-- Replace org name to match your staging test organization.
--
-- Replace this:
--   WHERE o.name ILIKE '%TestOrg%'

SELECT o.name,
       o.id,
       public.is_user_activity_insights_enabled(o.id) AS feature_enabled
FROM   public.organizations o
WHERE  o.name ILIKE '%TestOrg%';
-- Expected when feature is OFF: feature_enabled = false
-- Expected when feature is ON:  feature_enabled = true


-- ── 10. organization_features row for the test org ───────────────────────────
-- Replace org name as above.

SELECT of.organization_id, of.feature_key, of.enabled, of.updated_at
FROM   public.organization_features of
JOIN   public.organizations         o  ON o.id = of.organization_id
WHERE  o.name        ILIKE '%TestOrg%'
  AND  of.feature_key = 'user_activity_insights';
-- Expected: 0 rows (feature never enabled) or 1 row showing current enabled status
