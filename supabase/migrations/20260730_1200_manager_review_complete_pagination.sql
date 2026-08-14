-- Migration: Manager Review Complete Pagination
-- Created: 2026-07-30
-- Purpose: Add paginated RPCs for manager review expense loading with stable keyset cursors.
--          Existing RPCs (list_manager_pending_expenses, list_hierarchy_reviewer_expenses)
--          are preserved for rollback compatibility.
--
-- ***************************************************************************
-- SUPERSEDED by 20260731090000_reviewer_visible_expenses_scope.sql (DOC-074).
--
-- This file is retained so that a database which already ran it stays coherent,
-- and so a FRESH database can still apply it without error. It is repaired but
-- NOT the function set the application calls. Two reasons it is not canonical:
--
--   a) The filename does not start with a 14-digit timestamp, so the Supabase
--      CLI migration runner ignores it entirely (`npm run migrations:check`).
--   b) Team visibility here resolves only through teams.manager_user_id, which
--      is wrong for executive and team_leader reviewers.
--
-- Repairs applied on 2026-07-31:
--   * cycle protection added to the count function's recursive CTE, so count and
--     page can no longer disagree (or spin) on a cyclic reporting graph;
--   * both functions now bound recursion depth identically;
--   * both functions now verify the caller's ACTIVE organization membership
--     instead of trusting SECURITY DEFINER;
--   * ordering/keyset use COALESCE(updated_at, created_at, epoch) because
--     expenses.updated_at is nullable.
--
-- Earlier repairs (already committed): WITH RECURSIVE instead of WITH, and
-- RETURNS SETOF public.expenses instead of a hand-written record type that
-- referenced non-existent expenses columns (description, amount, currency).
-- ***************************************************************************
--
-- IMPORTANT: Do NOT execute this against production without running the diagnostic
--            files in docs/sql/review-loading/ first to verify the expected row counts.
--
-- Functions added:
--   1. count_manager_visible_review_expenses(p_organization_id uuid) → bigint
--   2. list_manager_visible_review_expenses_page(
--        p_organization_id uuid,
--        p_after_updated_at timestamptz DEFAULT NULL,
--        p_after_id uuid DEFAULT NULL,
--        p_page_size integer DEFAULT 250
--      ) → SETOF public.expenses (keyset paginated)

-- ---------------------------------------------------------------------------
-- 1. count_manager_visible_review_expenses
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.count_manager_visible_review_expenses(
  p_organization_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE
  org_profiles AS (
    SELECT user_id, reporting_engineer_id
    FROM profiles
    WHERE organization_id = p_organization_id
  ),
  -- Cycle-safe: `visited` carries the ancestry so a cyclic reporting_engineer_id
  -- chain terminates. Must match the page function's recursion exactly.
  reporting_tree AS (
    SELECT user_id, ARRAY[auth.uid(), user_id] AS visited
    FROM org_profiles
    WHERE reporting_engineer_id = auth.uid()
    UNION ALL
    SELECT p.user_id, rt.visited || p.user_id
    FROM org_profiles p
    INNER JOIN reporting_tree rt ON p.reporting_engineer_id = rt.user_id
    WHERE NOT (p.user_id = ANY (rt.visited))
      AND array_length(rt.visited, 1) < 64
  ),
  team_users AS (
    SELECT tm.user_id
    FROM team_members tm
    INNER JOIN teams t ON t.id = tm.team_id
    WHERE t.organization_id = p_organization_id
      AND t.manager_user_id = auth.uid()
  ),
  visible_users AS (
    SELECT user_id FROM reporting_tree
    UNION
    SELECT user_id FROM team_users
  )
  SELECT COUNT(*)
  FROM expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted', 'verified', 'approved', 'rejected', 'edited',
      'under_review', 'level_1_verified', 'level_2_verified'
    )
    AND EXISTS (
      SELECT 1 FROM organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
    )
    AND (
      e.user_id IN (SELECT user_id FROM visible_users)
      OR e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
    );
$$;

REVOKE EXECUTE ON FUNCTION public.count_manager_visible_review_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_manager_visible_review_expenses(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. list_manager_visible_review_expenses_page  (keyset paginated)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_manager_visible_review_expenses_page(
  p_organization_id  uuid,
  p_after_updated_at timestamptz DEFAULT NULL,
  p_after_id         uuid        DEFAULT NULL,
  p_page_size        integer     DEFAULT 250
)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE
  org_profiles AS (
    SELECT user_id, reporting_engineer_id
    FROM profiles
    WHERE organization_id = p_organization_id
  ),
  reporting_tree AS (
    SELECT user_id, ARRAY[auth.uid(), user_id] AS visited
    FROM org_profiles
    WHERE reporting_engineer_id = auth.uid()
    UNION ALL
    SELECT p.user_id, rt.visited || p.user_id
    FROM org_profiles p
    INNER JOIN reporting_tree rt ON p.reporting_engineer_id = rt.user_id
    WHERE NOT (p.user_id = ANY (rt.visited))
      AND array_length(rt.visited, 1) < 64
  ),
  team_users AS (
    SELECT tm.user_id
    FROM team_members tm
    INNER JOIN teams t ON t.id = tm.team_id
    WHERE t.organization_id = p_organization_id
      AND t.manager_user_id = auth.uid()
  ),
  visible_users AS (
    SELECT user_id FROM reporting_tree
    UNION
    SELECT user_id FROM team_users
  )
  SELECT e.*
  FROM expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted', 'verified', 'approved', 'rejected', 'edited',
      'under_review', 'level_1_verified', 'level_2_verified'
    )
    AND EXISTS (
      SELECT 1 FROM organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
    )
    AND (
      e.user_id IN (SELECT user_id FROM visible_users)
      OR e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
    )
    -- expenses.updated_at is nullable; the cursor must use the same expression as
    -- ORDER BY or NULL-updated_at rows get skipped permanently.
    AND (
      p_after_updated_at IS NULL
      OR COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) < p_after_updated_at
      OR (
        COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) = p_after_updated_at
        AND (p_after_id IS NULL OR e.id < p_after_id)
      )
    )
  ORDER BY
    COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) DESC,
    e.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 1000);
$$;

REVOKE EXECUTE ON FUNCTION public.list_manager_visible_review_expenses_page(uuid, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_visible_review_expenses_page(uuid, timestamptz, uuid, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.count_manager_visible_review_expenses(uuid) IS
  'Returns the total number of review expenses visible to the calling manager (auth.uid()).
   Includes all reporting-tree subordinates (recursive), managed team members,
   and expenses directly assigned to the manager.
   Added 2026-07-30 as part of the review-expense complete-loading fix (DOC-073).';

COMMENT ON FUNCTION public.list_manager_visible_review_expenses_page(uuid, timestamptz, uuid, integer) IS
  'Paginated keyset version of list_manager_pending_expenses.
   Cursor: p_after_updated_at + p_after_id. Order: updated_at DESC, id DESC.
   Page size capped at 1000. Returns SETOF public.expenses.
   Added 2026-07-30 as part of the review-expense complete-loading fix (DOC-073).
   Existing RPCs preserved for rollback compatibility.';
