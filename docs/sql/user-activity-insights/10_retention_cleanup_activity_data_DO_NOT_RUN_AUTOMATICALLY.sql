-- ============================================================
-- User Activity Insights — Retention Cleanup
-- docs/sql/user-activity-insights/10_retention_cleanup_activity_data_DO_NOT_RUN_AUTOMATICALLY.sql
--
-- Purpose:
--   Identifies and (when approved) deletes old activity data beyond
--   the recommended 180-day retention window.
--
-- ⚠️  WARNING — READ BEFORE RUNNING ANYTHING IN THIS FILE  ⚠️
--   1. This file contains both preview queries (safe) and DELETE
--      statements (commented out by default).
--   2. Deleted data CANNOT be recovered unless a database backup exists.
--   3. Run DELETE sections only after:
--       a. Written legal/admin approval is obtained.
--       b. You have confirmed a recent backup.
--       c. You have run the preview queries and reviewed the counts.
--       d. You have a ticket/reference ID for audit purposes.
--   4. This file must NOT be run automatically or scheduled without
--      explicit approval for each run.
--
-- Retention recommendation: 180 days (configurable below).
--   Adjust INTERVAL '180 days' to match your organisation's policy.
--
-- Tables affected:
--   public.user_activity_sessions
--   public.user_activity_daily_rollups
--
-- Tables NOT touched:
--   public.user_activity_notice_acknowledgements  (not deleted here)
--   public.expenses                               (never touched)
--   public.organizations                          (never touched)
--   public.auth.users                             (never touched)
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- SECTION 1 — PREVIEW: All-org rows older than 180 days
--   Run these read-only queries to understand what would be deleted.
-- ════════════════════════════════════════════════════════════

-- 1a. Count of session rows older than 180 days (all orgs)
SELECT
  COUNT(*)                                          AS session_rows_to_delete,
  MIN(started_at)                                   AS oldest_session,
  MAX(started_at)                                   AS newest_session_in_range
FROM public.user_activity_sessions
WHERE started_at < now() - INTERVAL '180 days';

-- 1b. Count of daily rollup rows older than 180 days (all orgs)
SELECT
  COUNT(*)                                          AS rollup_rows_to_delete,
  MIN(activity_date)                                AS oldest_rollup_date,
  MAX(activity_date)                                AS newest_rollup_date_in_range
FROM public.user_activity_daily_rollups
WHERE activity_date < (CURRENT_DATE - INTERVAL '180 days')::date;

-- 1c. Breakdown by organisation
SELECT
  o.name                                            AS org_name,
  o.id                                              AS org_id,
  COUNT(s.id)                                       AS session_rows,
  SUM(s.visible_seconds)                            AS total_visible_seconds_to_delete
FROM public.user_activity_sessions s
JOIN public.organizations o ON o.id = s.organization_id
WHERE s.started_at < now() - INTERVAL '180 days'
GROUP BY o.name, o.id
ORDER BY session_rows DESC;


-- ════════════════════════════════════════════════════════════
-- SECTION 2 — PREVIEW: Org-specific rows older than 180 days
--   Replace %ORG_NAME% or %ORG_ID% with actual values.
-- ════════════════════════════════════════════════════════════

-- 2a. Find org by name (partial match)
SELECT id, name FROM public.organizations
WHERE name ILIKE '%OrgName%';

-- 2b. Preview sessions for specific org by name
SELECT
  COUNT(*)                                          AS session_rows_to_delete,
  MIN(started_at)                                   AS oldest_session,
  MAX(started_at)                                   AS newest_in_range
FROM public.user_activity_sessions s
JOIN public.organizations o ON o.id = s.organization_id
WHERE o.name ILIKE '%OrgName%'
  AND s.started_at < now() - INTERVAL '180 days';

-- 2c. Preview rollups for specific org by name
SELECT
  COUNT(*)                                          AS rollup_rows_to_delete,
  MIN(activity_date)                                AS oldest_date,
  MAX(activity_date)                                AS newest_in_range
FROM public.user_activity_daily_rollups r
JOIN public.organizations o ON o.id = r.organization_id
WHERE o.name ILIKE '%OrgName%'
  AND r.activity_date < (CURRENT_DATE - INTERVAL '180 days')::date;

-- 2d. Preview sessions for specific org by id
--   Replace 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' with actual org UUID.
/*
SELECT COUNT(*), MIN(started_at), MAX(started_at)
FROM public.user_activity_sessions
WHERE organization_id = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
  AND started_at < now() - INTERVAL '180 days';
*/


-- ════════════════════════════════════════════════════════════
-- SECTION 3 — DELETE (ALL ORGS) — COMMENTED OUT BY DEFAULT
--   ⚠️  Uncomment only after written approval and backup confirmation.
--   ⚠️  Run in a transaction and ROLLBACK first to verify row counts.
-- ════════════════════════════════════════════════════════════

-- 3a. Delete all-org sessions older than 180 days
/*
BEGIN;

DELETE FROM public.user_activity_sessions
WHERE started_at < now() - INTERVAL '180 days';

-- Verify count before committing:
-- SELECT COUNT(*) FROM public.user_activity_sessions WHERE started_at < now() - INTERVAL '180 days';
-- Should return 0 after delete.

COMMIT;
-- ROLLBACK; -- uncomment to abort
*/

-- 3b. Delete all-org daily rollups older than 180 days
/*
BEGIN;

DELETE FROM public.user_activity_daily_rollups
WHERE activity_date < (CURRENT_DATE - INTERVAL '180 days')::date;

COMMIT;
-- ROLLBACK;
*/


-- ════════════════════════════════════════════════════════════
-- SECTION 4 — DELETE (ORG-SPECIFIC) — COMMENTED OUT BY DEFAULT
--   Replace %ORG_NAME% or %ORG_ID%.
-- ════════════════════════════════════════════════════════════

-- 4a. Delete sessions for a specific org by name
/*
BEGIN;

DELETE FROM public.user_activity_sessions
WHERE organization_id IN (
  SELECT id FROM public.organizations WHERE name ILIKE '%OrgName%'
)
AND started_at < now() - INTERVAL '180 days';

COMMIT;
-- ROLLBACK;
*/

-- 4b. Delete rollups for a specific org by name
/*
BEGIN;

DELETE FROM public.user_activity_daily_rollups
WHERE organization_id IN (
  SELECT id FROM public.organizations WHERE name ILIKE '%OrgName%'
)
AND activity_date < (CURRENT_DATE - INTERVAL '180 days')::date;

COMMIT;
-- ROLLBACK;
*/

-- 4c. Delete sessions for a specific org by id
/*
BEGIN;

DELETE FROM public.user_activity_sessions
WHERE organization_id = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
  AND started_at < now() - INTERVAL '180 days';

COMMIT;
-- ROLLBACK;
*/

-- 4d. Delete rollups for a specific org by id
/*
BEGIN;

DELETE FROM public.user_activity_daily_rollups
WHERE organization_id = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
  AND activity_date < (CURRENT_DATE - INTERVAL '180 days')::date;

COMMIT;
-- ROLLBACK;
*/


-- ════════════════════════════════════════════════════════════
-- SECTION 5 — POST-DELETE VERIFICATION (run after any delete)
-- ════════════════════════════════════════════════════════════

-- 5a. Confirm no sessions remain older than 180 days (expect 0)
/*
SELECT COUNT(*) AS remaining_old_sessions
FROM public.user_activity_sessions
WHERE started_at < now() - INTERVAL '180 days';
*/

-- 5b. Confirm no rollups remain older than 180 days (expect 0)
/*
SELECT COUNT(*) AS remaining_old_rollups
FROM public.user_activity_daily_rollups
WHERE activity_date < (CURRENT_DATE - INTERVAL '180 days')::date;
*/


-- ════════════════════════════════════════════════════════════
-- NOTE ON ACKNOWLEDGEMENT ROWS
--   user_activity_notice_acknowledgements rows are NOT deleted here.
--   These rows record that a user saw the tracking notice, and
--   deleting them would force re-acknowledgement on next login.
--   If you want to delete acknowledgements (e.g. after feature
--   is fully disabled for an org), use the erasure file (12_...).
-- ════════════════════════════════════════════════════════════
