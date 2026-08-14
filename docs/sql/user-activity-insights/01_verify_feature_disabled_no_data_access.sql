-- ============================================================
-- User Activity Insights — Feature-Disabled Verification
-- docs/sql/user-activity-insights/01_verify_feature_disabled_no_data_access.sql
--
-- READ-ONLY verification queries.
-- Run in the Supabase SQL Editor (staging only) WHILE the feature flag
-- is DISABLED for the test organization.
--
-- To disable: go to Master Admin dashboard → feature toggles →
--             turn OFF "User Activity Insights" for the test org.
-- Do NOT run UPDATE statements here to change the flag.
--
-- No destructive SQL. No DROP. No ALTER. No UPDATE. No DELETE.
-- ============================================================


-- ── IMPORTANT: Run these queries AFTER disabling the feature flag ─────────────
-- Disable via: Master Admin dashboard → Feature Toggles → OFF for test org.


-- ── 1. Confirm feature is disabled for the test org ──────────────────────────
-- Replace org name as needed.
--
-- Replace this:
--   WHERE o.name ILIKE '%TestOrg%'

SELECT o.name,
       public.is_user_activity_insights_enabled(o.id) AS should_be_false
FROM   public.organizations o
WHERE  o.name ILIKE '%TestOrg%';
-- Expected: should_be_false = false
-- If true: stop — feature is still enabled, disable it first.


-- ── 2. Direct table reads are blocked by RLS ─────────────────────────────────
-- NOTE: These two queries should be run as an org user (not service_role).
--       In Supabase SQL Editor with service_role, RLS is bypassed.
--       To test RLS properly: use the PostgREST client or call via the app.
--
-- As a sanity check using service_role, you can verify row count:

SELECT COUNT(*) AS session_rows_for_test_org
FROM   public.user_activity_sessions s
JOIN   public.organizations          o ON o.id = s.organization_id
WHERE  o.name ILIKE '%TestOrg%';
-- (service_role bypasses RLS — this shows raw data count)
-- When a regular user hits this via RLS: expect 0 rows returned (RLS blocks it)


-- ── 3. Summary RPC returns empty for admin ───────────────────────────────────
-- NOTE: This query simulates what get_user_activity_summary returns.
--       Actually calling the RPC as admin via the app will return empty rows.
--
-- Manual check: log in as admin from the disabled org → open
--   /admin/user-activity → table should show all users but with zero values
--   (the RPC returns RETURN; when feature disabled, which is an empty set).


-- ── 4. No rollup rows created for disabled org since disabling ───────────────
-- Check the timestamp of the last rollup for the test org.
-- If the feature was disabled at a known time, no rows should appear after it.
--
-- Replace org name as needed.

SELECT r.activity_date,
       r.user_id,
       r.visible_seconds,
       r.expenses_submitted_count,
       r.updated_at
FROM   public.user_activity_daily_rollups r
JOIN   public.organizations               o ON o.id = r.organization_id
WHERE  o.name ILIKE '%TestOrg%'
ORDER  BY r.updated_at DESC
LIMIT  10;
-- Expected: no rows updated after the feature was disabled.
-- If rows appear with updated_at AFTER you disabled: investigate trigger gate.


-- ── 5. Expense trigger no-ops for disabled org ───────────────────────────────
-- After disabling the feature: submit a test expense from an employee in
-- the disabled org. Then re-run query 4 above and confirm
-- expenses_submitted_count did NOT increment for today.
--
-- This verifies the trigger gate in trg_user_activity_expense_submitted.


-- ── 6. Session rows count before/after feature disabled ──────────────────────
-- Record the count before disabling, then confirm no new sessions are written.

SELECT COUNT(*) AS total_sessions,
       MAX(s.started_at) AS latest_session_started
FROM   public.user_activity_sessions s
JOIN   public.organizations          o ON o.id = s.organization_id
WHERE  o.name ILIKE '%TestOrg%';
-- Run once before disabling (baseline).
-- Run again after disabling and after employees log in.
-- latest_session_started should NOT advance after feature is disabled.
