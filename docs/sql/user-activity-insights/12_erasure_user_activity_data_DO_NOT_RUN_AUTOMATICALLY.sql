-- ============================================================
-- User Activity Insights — Erasure / Deletion for a User Request
-- docs/sql/user-activity-insights/12_erasure_user_activity_data_DO_NOT_RUN_AUTOMATICALLY.sql
--
-- Purpose:
--   Support Right to Erasure requests (deletion of one user's
--   activity data in one organisation).
--
-- ⚠️  WARNING — READ BEFORE RUNNING ANYTHING IN THIS FILE  ⚠️
--   1. DELETE sections are commented out by default.
--   2. Run PREVIEW sections first to confirm what will be deleted.
--   3. Obtain written/ticket approval before uncommenting DELETE.
--   4. Record the ticket/reference ID before running.
--   5. Deleted data CANNOT be recovered unless a DB backup exists.
--   6. Do NOT run this without verifying legal basis and approval.
--
-- Scope — ONLY deletes:
--   public.user_activity_sessions        (for that user + org)
--   public.user_activity_daily_rollups   (for that user + org)
--   public.user_activity_notice_acknowledgements (optional, section 7)
--
-- NOT affected:
--   public.expenses                      (never touched by this file)
--   public.organization_memberships      (never touched)
--   auth.users                           (never touched)
--   public.audit_logs                    (never touched)
--   Any other table                      (never touched)
--
-- Placeholders:
--   %USER_EMAIL%   →  requesting user's email address
--   %ORG_NAME%     →  organisation name (partial ILIKE match)
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- SECTION 1 — Identify target user and organisation
-- ════════════════════════════════════════════════════════════

-- 1a. Find user
SELECT id AS user_id, email, created_at
FROM auth.users
WHERE email ILIKE '%USER_EMAIL%';

-- 1b. Find org
SELECT id AS org_id, name AS org_name
FROM public.organizations
WHERE name ILIKE '%ORG_NAME%';

-- 1c. Confirm membership (ensures correct user+org pair)
SELECT
  om.user_id,
  om.organization_id,
  om.role::text AS role,
  u.email,
  o.name AS org_name
FROM public.organization_memberships om
JOIN auth.users u ON u.id = om.user_id
JOIN public.organizations o ON o.id = om.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%';


-- ════════════════════════════════════════════════════════════
-- SECTION 2 — PREVIEW: Sessions to be deleted
-- ════════════════════════════════════════════════════════════

SELECT
  COUNT(*)            AS sessions_to_delete,
  MIN(started_at)     AS earliest,
  MAX(started_at)     AS latest,
  SUM(visible_seconds) AS total_visible_seconds
FROM public.user_activity_sessions s
JOIN auth.users u ON u.id = s.user_id
JOIN public.organizations o ON o.id = s.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%';


-- ════════════════════════════════════════════════════════════
-- SECTION 3 — PREVIEW: Daily rollups to be deleted
-- ════════════════════════════════════════════════════════════

SELECT
  COUNT(*)             AS rollup_rows_to_delete,
  MIN(activity_date)   AS earliest_date,
  MAX(activity_date)   AS latest_date
FROM public.user_activity_daily_rollups r
JOIN auth.users u ON u.id = r.user_id
JOIN public.organizations o ON o.id = r.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%';


-- ════════════════════════════════════════════════════════════
-- SECTION 4 — PREVIEW: Acknowledgement rows
-- ════════════════════════════════════════════════════════════

SELECT
  a.id,
  a.notice_version,
  a.acknowledged_at
FROM public.user_activity_notice_acknowledgements a
JOIN auth.users u ON u.id = a.user_id
JOIN public.organizations o ON o.id = a.organization_id
WHERE u.email ILIKE '%USER_EMAIL%'
  AND o.name  ILIKE '%ORG_NAME%';


-- ════════════════════════════════════════════════════════════
-- SECTION 5 — DELETE: Sessions  (COMMENTED OUT BY DEFAULT)
--   Uncomment only after approval + backup confirmation.
--   Ticket/reference: _________________________
-- ════════════════════════════════════════════════════════════

/*
BEGIN;

DELETE FROM public.user_activity_sessions
WHERE user_id = (
  SELECT id FROM auth.users WHERE email ILIKE '%USER_EMAIL%' LIMIT 1
)
AND organization_id = (
  SELECT id FROM public.organizations WHERE name ILIKE '%ORG_NAME%' LIMIT 1
);

-- Verify (should return 0):
SELECT COUNT(*) AS remaining_sessions
FROM public.user_activity_sessions
WHERE user_id = (
  SELECT id FROM auth.users WHERE email ILIKE '%USER_EMAIL%' LIMIT 1
)
AND organization_id = (
  SELECT id FROM public.organizations WHERE name ILIKE '%ORG_NAME%' LIMIT 1
);

COMMIT;
-- ROLLBACK; -- uncomment to abort
*/


-- ════════════════════════════════════════════════════════════
-- SECTION 6 — DELETE: Daily rollups  (COMMENTED OUT BY DEFAULT)
-- ════════════════════════════════════════════════════════════

/*
BEGIN;

DELETE FROM public.user_activity_daily_rollups
WHERE user_id = (
  SELECT id FROM auth.users WHERE email ILIKE '%USER_EMAIL%' LIMIT 1
)
AND organization_id = (
  SELECT id FROM public.organizations WHERE name ILIKE '%ORG_NAME%' LIMIT 1
);

COMMIT;
-- ROLLBACK;
*/


-- ════════════════════════════════════════════════════════════
-- SECTION 7 — DELETE: Acknowledgements (OPTIONAL — SEPARATE DECISION)
--   Deleting acknowledgements means the user will see the notice
--   modal again if the feature remains enabled for their org.
--   Decide based on legal guidance before uncommenting.
-- ════════════════════════════════════════════════════════════

/*
BEGIN;

DELETE FROM public.user_activity_notice_acknowledgements
WHERE user_id = (
  SELECT id FROM auth.users WHERE email ILIKE '%USER_EMAIL%' LIMIT 1
)
AND organization_id = (
  SELECT id FROM public.organizations WHERE name ILIKE '%ORG_NAME%' LIMIT 1
);

COMMIT;
-- ROLLBACK;
*/


-- ════════════════════════════════════════════════════════════
-- SECTION 8 — POST-DELETE VERIFICATION
--   Run after completing the deletes above.
-- ════════════════════════════════════════════════════════════

/*
-- Should return 0:
SELECT COUNT(*) AS remaining_sessions
FROM public.user_activity_sessions
WHERE user_id = (SELECT id FROM auth.users WHERE email ILIKE '%USER_EMAIL%' LIMIT 1)
  AND organization_id = (SELECT id FROM public.organizations WHERE name ILIKE '%ORG_NAME%' LIMIT 1);

-- Should return 0:
SELECT COUNT(*) AS remaining_rollups
FROM public.user_activity_daily_rollups
WHERE user_id = (SELECT id FROM auth.users WHERE email ILIKE '%USER_EMAIL%' LIMIT 1)
  AND organization_id = (SELECT id FROM public.organizations WHERE name ILIKE '%ORG_NAME%' LIMIT 1);
*/
