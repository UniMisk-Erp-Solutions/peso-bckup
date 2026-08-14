-- ============================================================
-- User Activity Insights — Feature-Enabled Rollup Verification
-- docs/sql/user-activity-insights/02_verify_feature_enabled_rollups.sql
--
-- READ-ONLY verification queries.
-- Run in the Supabase SQL Editor (staging only) AFTER:
--   1. The feature flag has been enabled for the test org (via Master Admin).
--   2. An employee from that org has used the app for at least 2 minutes.
--   3. The admin has visited /admin/user-activity in the browser.
--
-- To enable: go to Master Admin dashboard → feature toggles →
--            turn ON "User Activity Insights" for ONE test org only.
-- Do NOT run UPDATE statements here to change the flag.
--
-- No destructive SQL. No DROP. No ALTER. No UPDATE. No DELETE.
-- ============================================================


-- ── IMPORTANT: Run these queries AFTER enabling the feature for one test org ──
-- Enable via: Master Admin dashboard → Feature Toggles → ON for test org only.


-- ── 1. Confirm feature is enabled for the test org ───────────────────────────
-- Replace org name as needed.
--
-- Replace this:
--   WHERE o.name ILIKE '%TestOrg%'

SELECT o.name,
       public.is_user_activity_insights_enabled(o.id) AS should_be_true
FROM   public.organizations o
WHERE  o.name ILIKE '%TestOrg%';
-- Expected: should_be_true = true
-- If false: enable the feature from Master Admin first.


-- ── 2. Sessions were created for the test org ────────────────────────────────

SELECT s.id,
       s.user_id,
       s.started_at,
       s.ended_at,
       s.last_seen_at,
       s.visible_seconds,
       s.heartbeat_count,
       s.user_agent
FROM   public.user_activity_sessions s
JOIN   public.organizations          o ON o.id = s.organization_id
WHERE  o.name ILIKE '%TestOrg%'
ORDER  BY s.started_at DESC
LIMIT  20;
-- Expected: rows present for employees who logged in after enabling the feature.
-- visible_seconds should increase with each heartbeat (every ~60s).
-- heartbeat_count increments each heartbeat.


-- ── 3. Daily rollup rows exist and visible_seconds increases ─────────────────

SELECT r.activity_date,
       r.user_id,
       r.visible_seconds,
       r.session_count,
       r.expenses_submitted_count,
       r.first_seen_at,
       r.last_seen_at,
       r.updated_at
FROM   public.user_activity_daily_rollups r
JOIN   public.organizations               o ON o.id = r.organization_id
WHERE  o.name ILIKE '%TestOrg%'
ORDER  BY r.activity_date DESC, r.updated_at DESC
LIMIT  20;
-- Expected:
-- - Rows for today's date present per active employee.
-- - visible_seconds > 0 after 1 heartbeat (60s visible in app).
-- - session_count >= 1 per employee who logged in.
-- - last_seen_at updates after each heartbeat.


-- ── 4. last_seen_at updates after each heartbeat ─────────────────────────────

SELECT r.user_id,
       r.activity_date,
       r.last_seen_at,
       r.visible_seconds
FROM   public.user_activity_daily_rollups r
JOIN   public.organizations               o ON o.id = r.organization_id
WHERE  o.name    ILIKE '%TestOrg%'
  AND  r.activity_date = current_date
ORDER  BY r.last_seen_at DESC;
-- Run once; wait 60s; run again.
-- Expected: last_seen_at advances by ~60s with each heartbeat.


-- ── 5. expenses_submitted_count increments after submitting an expense ────────
-- After an employee submits an expense (status = 'submitted'):

SELECT r.activity_date,
       r.user_id,
       r.expenses_submitted_count,
       r.updated_at
FROM   public.user_activity_daily_rollups r
JOIN   public.organizations               o ON o.id = r.organization_id
WHERE  o.name    ILIKE '%TestOrg%'
  AND  r.activity_date = current_date
ORDER  BY r.expenses_submitted_count DESC;
-- Expected: expenses_submitted_count = 1 (or more) for the employee who submitted.
-- If still 0: check that the expense status transitioned to 'submitted'
--   and that the trigger trg_user_activity_expense_submitted exists.


-- ── 6. Latest expense submission cross-check ─────────────────────────────────
-- Find the most recent submitted expense for the test org.

SELECT e.id,
       e.user_id,
       e.status,
       e.updated_at
FROM   public.expenses       e
JOIN   public.organizations  o ON o.id = e.organization_id
WHERE  o.name  ILIKE '%TestOrg%'
  AND  e.status = 'submitted'
ORDER  BY e.updated_at DESC
LIMIT  5;
-- Cross-reference: the user_id here should have expenses_submitted_count >= 1
-- in the rollup for today (query 5 above).


-- ── 7. No rollup rows created for OTHER orgs (feature still disabled for them) ─

SELECT o.name,
       public.is_user_activity_insights_enabled(o.id) AS feature_on,
       COUNT(r.id)                                     AS rollup_rows
FROM   public.organizations                o
LEFT   JOIN public.user_activity_daily_rollups r ON r.organization_id = o.id
                                                 AND r.activity_date = current_date
GROUP  BY o.name, o.id
ORDER  BY rollup_rows DESC;
-- Expected: only the test org (feature_on = true) has rollup_rows > 0.
-- All other orgs should have rollup_rows = 0 (trigger gate prevents writes).


-- ── 8. Session ended correctly (ended_at populated) ─────────────────────────
-- After closing the test browser tab or signing out:

SELECT s.id,
       s.user_id,
       s.started_at,
       s.ended_at,
       s.visible_seconds
FROM   public.user_activity_sessions s
JOIN   public.organizations          o ON o.id = s.organization_id
WHERE  o.name ILIKE '%TestOrg%'
ORDER  BY s.started_at DESC
LIMIT  5;
-- Expected: ended_at is populated for sessions where the tab was closed.
-- A session without ended_at means the tab was still open or end_user_activity_session
-- did not fire (acceptable on hard browser crash).
