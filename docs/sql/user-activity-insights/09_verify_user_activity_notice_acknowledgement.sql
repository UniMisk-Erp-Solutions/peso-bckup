-- ============================================================
-- User Activity Insights — Verification: Notice Acknowledgement
-- docs/sql/user-activity-insights/09_verify_user_activity_notice_acknowledgement.sql
--
-- READ-ONLY. No destructive SQL in this file.
-- Run after: 08_user_activity_notice_acknowledgement.sql
--
-- Browser verification steps:
--   1. Enable feature for one org in Master Admin
--   2. Log in as an employee of that org
--   3. Confirm notice modal appears on first login
--   4. Click "I understand"
--   5. Refresh — confirm modal does NOT appear again
--   6. /admin/user-activity still loads correctly
--   7. Log in as a user in a feature-DISABLED org — confirm NO modal
-- ============================================================


-- ── Check 1: Table exists ─────────────────────────────────────────────────────
-- Expected: one row with relname = 'user_activity_notice_acknowledgements'

SELECT relname, relkind
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public'
  AND  c.relname = 'user_activity_notice_acknowledgements';


-- ── Check 2: RLS is enabled ───────────────────────────────────────────────────
-- Expected: relrowsecurity = true

SELECT relname, relrowsecurity
FROM   pg_class
WHERE  relname = 'user_activity_notice_acknowledgements'
  AND  relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');


-- ── Check 3: Policies exist ───────────────────────────────────────────────────
-- Expected: two SELECT policies

SELECT polname, polcmd, polroles
FROM   pg_policies
WHERE  tablename  = 'user_activity_notice_acknowledgements'
  AND  schemaname = 'public';


-- ── Check 4: Both RPCs exist ──────────────────────────────────────────────────
-- Expected: two rows — has_acknowledged_user_activity_notice,
--                       acknowledge_user_activity_notice

SELECT p.proname,
       l.lanname   AS language,
       p.prosecdef AS security_definer
FROM   pg_proc     p
JOIN   pg_language l ON l.oid = p.prolang
WHERE  p.proname IN (
  'has_acknowledged_user_activity_notice',
  'acknowledge_user_activity_notice'
)
  AND  p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');


-- ── Check 5: Acknowledgement count by org ────────────────────────────────────
-- Expected: one row per org/version after employees have acknowledged.
-- Zero rows is normal before any employee has clicked "I understand".

SELECT o.name              AS org_name,
       a.notice_version,
       COUNT(*)            AS acknowledged_count
FROM   public.user_activity_notice_acknowledgements a
JOIN   public.organizations o ON o.id = a.organization_id
GROUP  BY o.name, a.notice_version
ORDER  BY o.name, a.notice_version;


-- ── Check 6: Function definitions contain SECURITY DEFINER ───────────────────
-- Expected: prosecdef = true for both functions

SELECT p.proname,
       p.prosecdef,
       pg_get_functiondef(p.oid) AS definition
FROM   pg_proc p
WHERE  p.proname IN (
  'has_acknowledged_user_activity_notice',
  'acknowledge_user_activity_notice'
)
  AND  p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');


-- ── Check 7: Table unique constraint ─────────────────────────────────────────
-- Expected: one unique constraint on (organization_id, user_id, notice_version)

SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  conrelid = 'public.user_activity_notice_acknowledgements'::regclass
  AND  contype  = 'u';
