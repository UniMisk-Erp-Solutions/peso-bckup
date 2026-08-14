-- ============================================================
-- FILE: 06_rls_team_reports_policy.sql
-- PURPOSE: Add the missing RLS SELECT policy that allows
--          team leaders, executives, and managers to read
--          verified/approved expenses from their team members.
--          This is the ROOT CAUSE of Team Reports showing
--          "No expenses found" for the executive role.
--
-- ROOT CAUSE CONFIRMED:
--   - DB has 357 matching rows (file 03 query confirmed)
--   - Index works: Bitmap Index Scan, 9ms (file 02 confirmed)
--   - RLS strips ALL rows when authenticated user fires the query
--   - Existing policies do not cover team-wide verified expense
--     visibility for Team Reports
--
-- WHY THE PREVIOUS POLICY RETURNED 0 ROWS (Step 4):
--   The original policy only checked teams.executive_user_id /
--   team_leader_user_id / manager_user_id (formal team path).
--   But this executive is NOT assigned to any team row in the
--   teams table. list_my_teams_overview uses a HIERARCHY FALLBACK
--   via profiles.reporting_engineer_id when no formal team is
--   assigned. The 225 members shown in the UI come from
--   get_subordinate_user_ids() — a recursive CTE on the
--   reporting_engineer_id chain — NOT from team_members.
--
--   Fix: policy must cover BOTH paths:
--     Path 1 — formal team membership (teams + team_members)
--     Path 2 — hierarchy fallback (get_subordinate_user_ids)
--
-- SAFE: This is an additive RLS policy only.
--       It does not modify any data, schema, or other policies.
--       It can be dropped with the rollback at the bottom of
--       file 99 if needed.
--
-- RUN THIS IN SUPABASE SQL EDITOR — one statement at a time.
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- STEP 1: Check whether an old version of this policy exists
-- ──────────────────────────────────────────────────────────
-- If it returns a row, the old (broken) policy is present.
-- The next step drops it and recreates the correct dual-path version.

SELECT policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'expenses'
  AND policyname = 'Team leaders and executives can view team member expenses';


-- ──────────────────────────────────────────────────────────
-- STEP 2: Drop old version (if any) and create the corrected policy
-- ──────────────────────────────────────────────────────────
-- Run this regardless of whether Step 1 returned a row.
-- The DROP IF EXISTS is safe.
--
-- What this policy does:
--   Allows SELECT on verified/approved expenses when the viewer is
--   reachable as a team leader via EITHER:
--     Path 1 — the expense owner is a member of a formal team
--               where the viewer is set as team_leader_user_id,
--               executive_user_id, or manager_user_id
--     Path 2 — the expense owner is a direct/indirect report of
--               the viewer via the reporting_engineer_id hierarchy
--               (mirrors list_my_teams_overview hierarchy fallback)
--
-- This exactly mirrors how list_my_teams_overview decides which
-- members to show: formal team first, then hierarchy fallback.

DROP POLICY IF EXISTS "Team leaders and executives can view team member expenses"
  ON public.expenses;

CREATE POLICY "Team leaders and executives can view team member expenses"
  ON public.expenses
  FOR SELECT
  USING (
    status IN (
      'verified',
      'level_1_verified',
      'level_2_verified',
      'approved'
    )
    AND (
      -- Path 1: Formal team membership (teams + team_members)
      -- Covers users explicitly set as TL/exec/manager on a teams row.
      EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
         AND t.organization_id = tm.organization_id
        WHERE tm.user_id = expenses.user_id
          AND tm.organization_id = expenses.organization_id
          AND (
            t.team_leader_user_id = auth.uid()
            OR t.executive_user_id = auth.uid()
            OR t.manager_user_id   = auth.uid()
          )
      )
      OR
      -- Path 2: Supervisor hierarchy fallback (reporting_engineer_id chain)
      -- Covers the case where the viewer has no formal team row assignment.
      -- get_subordinate_user_ids() is SECURITY DEFINER + STABLE — safe in RLS.
      EXISTS (
        SELECT 1
        FROM public.get_subordinate_user_ids(expenses.organization_id, auth.uid()) sub
        WHERE sub.user_id = expenses.user_id
      )
    )
  );


-- ──────────────────────────────────────────────────────────
-- STEP 3: Verify the policy was created
-- ──────────────────────────────────────────────────────────

SELECT
  policyname,
  cmd,
  qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'expenses'
  AND policyname = 'Team leaders and executives can view team member expenses';


-- ──────────────────────────────────────────────────────────
-- STEP 4A: Verify via formal team path (as service role)
-- ──────────────────────────────────────────────────────────
-- If this executive is on a formal team: should return > 0.
-- If 0: this executive uses the hierarchy path (see Step 4B).

SELECT COUNT(*) AS rows_visible_via_formal_teams
FROM public.expenses e
WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND e.status IN ('verified', 'level_1_verified', 'level_2_verified', 'approved')
  AND EXISTS (
    SELECT 1
    FROM public.team_members tm
    JOIN public.teams t
      ON t.id = tm.team_id
     AND t.organization_id = tm.organization_id
    WHERE tm.user_id = e.user_id
      AND tm.organization_id = e.organization_id
      AND (
        t.team_leader_user_id = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
        OR t.executive_user_id = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
        OR t.manager_user_id   = '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
      )
  );


-- ──────────────────────────────────────────────────────────
-- STEP 4B: Verify via hierarchy path (as service role)
-- ──────────────────────────────────────────────────────────
-- This is the path that list_my_teams_overview uses for this user.
-- Expected: > 0 (the 225 hierarchy reports should have verified expenses).

SELECT COUNT(*) AS rows_visible_via_hierarchy
FROM public.expenses e
WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND e.status IN ('verified', 'level_1_verified', 'level_2_verified', 'approved')
  AND EXISTS (
    SELECT 1
    FROM public.get_subordinate_user_ids(
      '6709c1fe-e8c8-404d-bc68-d1edda923344',
      '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
    ) sub
    WHERE sub.user_id = e.user_id
  );


-- ──────────────────────────────────────────────────────────
-- STEP 4C: Also confirm this user has hierarchy reports at all
-- ──────────────────────────────────────────────────────────
-- Should return 225 rows (or similar count) to confirm the
-- hierarchy path is resolving correctly.

SELECT COUNT(*) AS subordinate_count
FROM public.get_subordinate_user_ids(
  '6709c1fe-e8c8-404d-bc68-d1edda923344',
  '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'
);


-- ──────────────────────────────────────────────────────────
-- WHAT TO EXPECT AFTER RUNNING THIS FILE
-- ──────────────────────────────────────────────────────────
--
-- Step 4A may return 0 (expected if user has no formal team row).
-- Step 4B should return > 0 (357 or similar).
-- Step 4C should return ~225.
--
-- If Step 4B and 4C both return 0:
--   → profiles.reporting_engineer_id is not set for this org's members
--   → Check: SELECT COUNT(*) FROM profiles WHERE reporting_engineer_id =
--     '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c' AND organization_id = '6709c1fe-...'
--
-- After confirming Step 4B > 0:
--   Refresh the Team Reports page in the browser.
--   The Claim Verification List should now show expenses.
