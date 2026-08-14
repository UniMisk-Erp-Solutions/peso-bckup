-- ============================================================
-- User Activity Insights — Production Preflight Check
-- docs/sql/user-activity-insights/99_production_preflight_DO_NOT_RUN_MIGRATION_YET.sql
--
-- READ-ONLY ONLY. No DROP, no ALTER, no INSERT, no UPDATE, no DELETE.
--
-- Run this BEFORE applying the migration in production.
-- If any check shows the objects already exist, STOP — do not
-- re-run the migration without investigating why they are there.
--
-- If any org already has user_activity_insights enabled = true, STOP.
-- That means someone has already applied the feature without this checklist.
--
-- If production traffic looks high (recent expense count > expected), consider
-- running during low-traffic hours (overnight / weekend).
--
-- Migration file (do NOT run yet):
--   supabase/migrations/290713_0900_user_activity_insights.sql
-- ============================================================


-- ── 1. Do the new TABLES already exist? ──────────────────────────────────────
-- Expected for a clean installation: 0 rows.
-- If this returns rows, STOP — the migration may have already been run.

SELECT table_name, table_type
FROM   information_schema.tables
WHERE  table_schema = 'public'
  AND  table_name   IN ('user_activity_sessions', 'user_activity_daily_rollups')
ORDER  BY table_name;
-- PASS: 0 rows returned
-- FAIL: 1 or 2 rows returned → STOP before migration


-- ── 2. Do the new INDEXES already exist? ─────────────────────────────────────
-- Expected for a clean installation: 0 rows.

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
-- PASS: 0 rows returned
-- FAIL: any rows returned → STOP before migration


-- ── 3. Do the new FUNCTIONS already exist? ───────────────────────────────────
-- Expected for a clean installation: 0 rows.

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
    'get_user_activity_detail',
    'trg_user_activity_expense_submitted'
  )
ORDER  BY routine_name;
-- PASS: 0 rows returned
-- FAIL: any rows returned → STOP before migration


-- ── 4. Does the TRIGGER already exist? ───────────────────────────────────────
-- Expected for a clean installation: 0 rows.

SELECT trigger_name, event_manipulation, event_object_table, action_timing
FROM   information_schema.triggers
WHERE  trigger_schema     = 'public'
  AND  trigger_name       = 'trg_user_activity_expense_submitted'
  AND  event_object_table = 'expenses';
-- PASS: 0 rows returned
-- FAIL: any rows returned → STOP before migration


-- ── 5. Do RLS POLICIES with these names already exist? ───────────────────────
-- Expected for a clean installation: 0 rows.
-- CREATE POLICY in Postgres fails if a policy with the same name already exists.
-- Re-running the migration without prior cleanup will error here.

SELECT policyname, tablename, cmd
FROM   pg_policies
WHERE  schemaname = 'public'
  AND  policyname IN (
    'Org admins can read activity sessions',
    'Users can read own activity sessions',
    'Org admins can read activity rollups',
    'Users can read own activity rollups'
  )
ORDER  BY tablename, policyname;
-- PASS: 0 rows returned
-- FAIL: any rows returned → STOP — running the migration again will error on CREATE POLICY


-- ── 6. Does any org already have the feature enabled? ────────────────────────
-- Expected: 0 rows.
-- If any org has this enabled, it is pointing at non-existent RPCs and tables.
-- That would be a misconfiguration — investigate before proceeding.

SELECT o.name   AS org_name,
       of.enabled,
       of.updated_at
FROM   public.organization_features of
JOIN   public.organizations         o ON o.id = of.organization_id
WHERE  of.feature_key = 'user_activity_insights'
  AND  of.enabled     = true;
-- PASS: 0 rows returned
-- FAIL: any rows returned → STOP and disable the flag first via Master Admin


-- ── 7. Count of ALL production organizations ─────────────────────────────────
-- Use this to understand scope. Migration adds a trigger to expenses, which
-- fires on every status update for ALL orgs — but the trigger no-ops when the
-- feature is disabled, so this is for situational awareness only.

SELECT COUNT(*) AS total_orgs
FROM   public.organizations;
-- Review: is this the number of orgs you expect on production?


-- ── 8. Recent expense activity (last 24 hours) ───────────────────────────────
-- The trigger will fire on every expense status update (INSERT or status UPDATE).
-- It no-ops when feature is disabled, but it is good to know traffic volume.
-- If this number is very high, plan migration for off-peak hours.

SELECT COUNT(*) AS expenses_updated_last_24h
FROM   public.expenses
WHERE  updated_at >= NOW() - INTERVAL '24 hours';
-- Review: if count is very high (thousands), plan for low-traffic window.
-- The trigger overhead is minimal (one feature flag lookup + no-op return),
-- but knowing the traffic helps you evaluate timing risk.


-- ── 9. Confirm organization_features table has expected columns ───────────────
-- The migration calls is_user_activity_insights_enabled() which reads
-- organization_features(organization_id, feature_key, enabled).
-- Confirm these columns exist before running.

SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'organization_features'
  AND  column_name  IN ('organization_id', 'feature_key', 'enabled')
ORDER  BY column_name;
-- PASS: 3 rows returned (organization_id uuid, feature_key text, enabled boolean)
-- FAIL: missing column → STOP — schema mismatch, investigate before migration


-- ── 10. Confirm expenses table has expected columns ───────────────────────────
-- The expense trigger reads NEW.organization_id, NEW.user_id, NEW.status,
-- NEW.updated_at. Confirm all exist.

SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'expenses'
  AND  column_name  IN ('organization_id', 'user_id', 'status', 'updated_at')
ORDER  BY column_name;
-- PASS: 4 rows returned
-- FAIL: missing column → STOP — trigger will fail at runtime if column is absent


-- ── SUMMARY ───────────────────────────────────────────────────────────────────
--
-- All 10 checks above must return "PASS" results before running the migration.
-- Specifically:
--
--   Checks 1–5:   All must return 0 rows (objects do not already exist)
--   Check  6:     Must return 0 rows (feature not enabled anywhere)
--   Checks 7–8:   Informational — review and decide on timing
--   Checks 9–10:  Must return 3 rows and 4 rows respectively (schema intact)
--
-- If ALL checks pass: you may proceed with the migration during a low-traffic window.
-- If ANY check fails: STOP and investigate before running the migration.
--
-- Next step after migration:
--   Run docs/sql/user-activity-insights/00_verify_installation.sql to confirm
--   all objects were created correctly.
-- ============================================================
