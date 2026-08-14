-- ============================================================
-- User Activity Insights — ROLLBACK SQL
-- docs/sql/user-activity-insights/99_rollback_user_activity_insights_DO_NOT_RUN.sql
--
-- ⚠️  WARNING: THIS IS DESTRUCTIVE. DO NOT RUN UNLESS ROLLBACK IS
--    EXPLICITLY APPROVED BY THE PROJECT OWNER.
--
-- This script permanently deletes:
--   - All collected user activity session data
--   - All collected user activity daily rollup data
--   - All RPCs, the helper function, and the expense trigger
--
-- Before running this script, ensure ALL of the following:
--   1. The feature flag 'user_activity_insights' is DISABLED for ALL orgs via
--      Master Admin. The tracker must not be calling RPCs when they are dropped.
--   2. The frontend has been deployed with the feature disabled or the
--      UserActivityTracker component removed.
--   3. You have an explicit approval from the project owner.
--   4. You have taken a database backup/snapshot before running.
--   5. You are running during off-peak hours, as the DROP TRIGGER on expenses
--      acquires a brief table lock.
--
-- This script does NOT roll back:
--   - The feature flag key in organizationFeatureKeys.ts (safe to leave)
--   - The master.json i18n label (safe to leave)
--   - The frontend pages and components (safe to leave — they fail gracefully)
--   - Any organization_features rows for 'user_activity_insights'
--     (disable them via Master Admin first; do not delete from SQL)
--
-- Run order: trigger → trigger function → RPCs (read first) → write RPCs
-- → helper function → tables. Dependencies must be removed last.
-- ============================================================


-- ── Step 1. Drop the expense trigger ─────────────────────────────────────────
-- Must be first — the trigger references the function in step 2.
-- Dropping the trigger is safe even if no trigger exists.
-- A brief ACCESS EXCLUSIVE lock on the expenses table is acquired — minimal
-- impact as the operation is instantaneous (metadata-only change).

DROP TRIGGER IF EXISTS trg_user_activity_expense_submitted
  ON public.expenses;


-- ── Step 2. Drop the trigger function ────────────────────────────────────────

DROP FUNCTION IF EXISTS public.trg_user_activity_expense_submitted();


-- ── Step 3. Drop read RPCs (detail, timeline, summary) ───────────────────────
-- Drop read RPCs before write RPCs — no dependencies between them, but
-- dropping reads first ensures admin page errors before tracker does.

DROP FUNCTION IF EXISTS public.get_user_activity_detail(uuid, date, date);
DROP FUNCTION IF EXISTS public.get_user_activity_timeline(uuid, date, date);
DROP FUNCTION IF EXISTS public.get_user_activity_summary(date, date);


-- ── Step 4. Drop write RPCs ───────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.end_user_activity_session(uuid);
DROP FUNCTION IF EXISTS public.record_user_activity_heartbeat(uuid, integer);
DROP FUNCTION IF EXISTS public.start_user_activity_session(text);


-- ── Step 5. Drop the helper function ─────────────────────────────────────────
-- Must be last among functions — RLS policies reference it. However, RLS policies
-- are dropped automatically when the tables are dropped in step 6, so this order
-- is safe: the policies disappear with the tables before any FK check on the function.

DROP FUNCTION IF EXISTS public.is_user_activity_insights_enabled(uuid);


-- ── Step 6. Drop tables (and their RLS policies + indexes automatically) ─────
-- Dropping a table in Postgres automatically drops:
--   - All RLS policies on the table
--   - All indexes on the table
--   - All constraints on the table
-- No need to drop them explicitly.
--
-- ⚠️  THIS PERMANENTLY DELETES ALL COLLECTED ACTIVITY DATA.

DROP TABLE IF EXISTS public.user_activity_sessions;
DROP TABLE IF EXISTS public.user_activity_daily_rollups;


-- ── Verification after rollback ───────────────────────────────────────────────
-- Run these SELECT checks to confirm everything was removed:

SELECT table_name
FROM   information_schema.tables
WHERE  table_schema = 'public'
  AND  table_name   IN ('user_activity_sessions', 'user_activity_daily_rollups');
-- Expected: 0 rows

SELECT routine_name
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
  );
-- Expected: 0 rows

SELECT trigger_name
FROM   information_schema.triggers
WHERE  trigger_name = 'trg_user_activity_expense_submitted';
-- Expected: 0 rows

-- ── After rollback: frontend behavior ────────────────────────────────────────
-- The UserActivityTracker component will still mount in Layout.tsx but:
--   - shouldRun gate will prevent any RPC calls (feature flag is disabled)
--   - If the feature flag is accidentally re-enabled, RPCs will fail and the
--     tracker will console.warn only — no app breakage.
-- The /admin/user-activity page will show an error card if opened.
-- The UserManagement "Activity Insights" button will be hidden (feature off).
--
-- To fully clean up the frontend: disable the feature flag in all orgs (via
-- Master Admin) and leave the frontend code in place — it is safe.
-- ============================================================
