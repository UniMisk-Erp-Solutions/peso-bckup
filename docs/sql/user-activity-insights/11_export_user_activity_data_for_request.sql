-- ============================================================
-- User Activity Insights — Data Access / Export for a User Request
-- docs/sql/user-activity-insights/11_export_user_activity_data_for_request.sql
--
-- Purpose:
--   Support data-principal access requests (Right to Access / DPDP §11).
--   Produces a full read-only export of one user's activity data.
--
-- This file contains SELECT statements ONLY.
-- No DELETE, no UPDATE, no INSERT.
--
-- Usage:
--   1. Replace %USER_EMAIL% with the requesting user's email address.
--   2. Replace %ORG_NAME%  with the organisation's name (partial match).
--   3. Run each section in order in the Supabase SQL Editor (master admin).
--   4. Copy results and send to the user / store as response record.
--
-- Data included:
--   - User identity / org membership
--   - Acknowledgement records
--   - Daily activity rollups
--   - Session rows
--   - Summary totals
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- SECTION 1 — Identify user and organisation
-- ════════════════════════════════════════════════════════════

-- 1a. Find user by email
SELECT
  u.id                        AS user_id,
  u.email,
  u.created_at                AS account_created_at,
  u.last_sign_in_at
FROM auth.users u
WHERE u.email ILIKE '%USER_EMAIL%';

-- 1b. Find organisation by name
SELECT
  o.id                        AS org_id,
  o.name                      AS org_name,
  o.created_at
FROM public.organizations o
WHERE o.name ILIKE '%ORG_NAME%';

-- 1c. Confirm membership: user belongs to this org
SELECT
  om.user_id,
  om.organization_id,
  om.role::text               AS role,
  om.created_at               AS joined_at
FROM public.organization_memberships om
JOIN auth.users u ON u.id = om.user_id
JOIN public.organizations o ON o.id = om.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%';


-- ════════════════════════════════════════════════════════════
-- SECTION 2 — Acknowledgement records
--   Shows when the user saw and acknowledged the activity notice.
-- ════════════════════════════════════════════════════════════

SELECT
  a.id,
  a.organization_id,
  a.user_id,
  a.notice_version,
  a.acknowledged_at,
  a.created_at
FROM public.user_activity_notice_acknowledgements a
JOIN auth.users u ON u.id = a.user_id
JOIN public.organizations o ON o.id = a.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%'
ORDER BY a.acknowledged_at DESC;


-- ════════════════════════════════════════════════════════════
-- SECTION 3 — Daily activity rollups
--   One row per day showing summarised activity.
-- ════════════════════════════════════════════════════════════

SELECT
  r.activity_date,
  r.first_seen_at,
  r.last_seen_at,
  r.visible_seconds,
  ROUND(r.visible_seconds / 60.0, 1)   AS visible_minutes,
  r.session_count,
  r.expenses_submitted_count,
  r.is_active
FROM public.user_activity_daily_rollups r
JOIN auth.users u ON u.id = r.user_id
JOIN public.organizations o ON o.id = r.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%'
ORDER BY r.activity_date DESC;


-- ════════════════════════════════════════════════════════════
-- SECTION 4 — Session rows
--   One row per tracked in-app session.
-- ════════════════════════════════════════════════════════════

SELECT
  s.id                        AS session_id,
  s.started_at,
  s.ended_at,
  s.last_seen_at,
  s.visible_seconds,
  s.heartbeat_count,
  s.user_agent
FROM public.user_activity_sessions s
JOIN auth.users u ON u.id = s.user_id
JOIN public.organizations o ON o.id = s.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%'
ORDER BY s.started_at DESC;


-- ════════════════════════════════════════════════════════════
-- SECTION 5 — Summary totals
-- ════════════════════════════════════════════════════════════

SELECT
  COUNT(DISTINCT r.activity_date)       AS total_active_days,
  SUM(r.visible_seconds)                AS total_visible_seconds,
  ROUND(SUM(r.visible_seconds) / 3600.0, 2)
                                        AS total_visible_hours,
  SUM(r.session_count)                  AS total_sessions,
  SUM(r.expenses_submitted_count)       AS total_expenses_tracked,
  MIN(r.activity_date)                  AS earliest_activity_date,
  MAX(r.activity_date)                  AS latest_activity_date
FROM public.user_activity_daily_rollups r
JOIN auth.users u ON u.id = r.user_id
JOIN public.organizations o ON o.id = r.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%';


-- ════════════════════════════════════════════════════════════
-- SECTION 6 — Notes for support / admin
-- ════════════════════════════════════════════════════════════

/*
  WHAT IS NOT EXPORTED HERE:
  - Keystrokes, screenshots, screen recording: never collected.
  - Websites, other apps, off-app activity: never collected.
  - Location, camera, microphone: never collected.
  - Expense content (amounts, categories): separately controlled.

  HOW TO USE THIS EXPORT:
  1. Run each section above with your Supabase credentials.
  2. Copy output as CSV (Supabase SQL Editor → Download).
  3. Deliver to the requesting data principal within your legally
     required response window (confirm with legal counsel).
  4. Log this request in your organisation's access-request register.
  5. Keep a record of who ran this query, when, and for which ticket.

  RETENTION NOTE:
  Activity data older than your configured retention period (default 180 days)
  may already be deleted. If the export shows no rows for older dates, the
  data was already cleaned up and is not recoverable.
*/
