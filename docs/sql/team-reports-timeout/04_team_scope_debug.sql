-- ============================================================
-- FILE: 04_team_scope_debug.sql
-- PURPOSE: Debug team membership — if DB has verified expenses
--          but UI still shows empty after the RLS policy is added.
--          Also useful to confirm the executive IS assigned to teams.
--
-- CORRECTED COLUMN NAMES (confirmed from actual schema error):
--   teams.team_leader_user_id  (NOT team_leader_id)
--   teams.executive_user_id    (NOT executive_id)
--   teams.manager_user_id      (confirmed from existing RLS)
--
-- VIEWER USER_ID (from JWT in the failing network request):
--   6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c
--
-- ORG ID: 6709c1fe-e8c8-404d-bc68-d1edda923344
-- SAFE: Read-only. No data changes.
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- QUERY 1: What role does the viewer have in this org?
-- ──────────────────────────────────────────────────────────
-- Expected: role IN ('executive', 'admin', 'team_leader', 'engineer')
-- If missing or role = 'employee' → canViewTeamReports = false

SELECT
  om.user_id,
  om.role,
  om.is_active,
  p.name
FROM public.organization_memberships om
JOIN public.profiles p ON p.user_id = om.user_id
WHERE om.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND om.user_id = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c';


-- ──────────────────────────────────────────────────────────
-- QUERY 2: Which teams does the viewer lead, exec, or manage?
-- ──────────────────────────────────────────────────────────
-- Uses correct column names: team_leader_user_id, executive_user_id, manager_user_id
-- If 0 rows: list_my_teams_overview returns empty → teamMemberUserIds = []
-- → Every row fetched is filtered out in memory → "No expenses found"
-- Fix: assign this user as TL/exec/manager on at least one team

SELECT
  t.id               AS team_id,
  t.name             AS team_name,
  t.team_leader_user_id,
  t.executive_user_id,
  t.manager_user_id,
  tl.name            AS team_leader_name,
  ex.name            AS executive_name,
  mgr.name           AS manager_name
FROM public.teams t
LEFT JOIN public.profiles tl  ON tl.user_id  = t.team_leader_user_id
LEFT JOIN public.profiles ex  ON ex.user_id  = t.executive_user_id
LEFT JOIN public.profiles mgr ON mgr.user_id = t.manager_user_id
WHERE t.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND (
    t.team_leader_user_id = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
    OR t.executive_user_id  = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
    OR t.manager_user_id    = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
  );


-- ──────────────────────────────────────────────────────────
-- QUERY 3: Member count per team managed by this viewer
-- ──────────────────────────────────────────────────────────

SELECT
  t.name              AS team_name,
  COUNT(tm.user_id)   AS member_count
FROM public.teams t
JOIN public.team_members tm ON tm.team_id = t.id
WHERE t.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND (
    t.team_leader_user_id = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
    OR t.executive_user_id  = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
    OR t.manager_user_id    = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
  )
GROUP BY t.name;


-- ──────────────────────────────────────────────────────────
-- QUERY 4: Team member user_ids visible to this viewer
-- ──────────────────────────────────────────────────────────
-- This is the set the frontend builds as teamMemberUserIds.

SELECT DISTINCT
  tm.user_id,
  p.name
FROM public.teams t
JOIN public.team_members tm ON tm.team_id = t.id
JOIN public.profiles p      ON p.user_id  = tm.user_id
WHERE t.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND (
    t.team_leader_user_id = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
    OR t.executive_user_id  = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
    OR t.manager_user_id    = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
  )
ORDER BY p.name;


-- ──────────────────────────────────────────────────────────
-- QUERY 5: Verified expenses belonging to those team members
-- ──────────────────────────────────────────────────────────
-- If 0 rows: team members have no verified expenses yet.
-- If > 0 rows: data exists but RLS or team scope is blocking.

SELECT
  e.status,
  COUNT(DISTINCT e.id)      AS expense_count,
  COUNT(DISTINCT e.user_id) AS employee_count
FROM public.expenses e
WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND e.status IN ('verified', 'level_1_verified', 'level_2_verified')
  AND e.user_id IN (
    SELECT DISTINCT tm.user_id
    FROM public.teams t
    JOIN public.team_members tm ON tm.team_id = t.id
    WHERE t.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
      AND (
        t.team_leader_user_id = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
        OR t.executive_user_id  = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
        OR t.manager_user_id    = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
      )
  )
GROUP BY e.status;


-- ──────────────────────────────────────────────────────────
-- QUERY 6: Feature flags (teams_enabled / approval_hierarchy)
-- ──────────────────────────────────────────────────────────

SELECT feature_key, enabled
FROM public.organization_features
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND feature_key IN ('teams_enabled', 'approval_hierarchy')
ORDER BY feature_key;
