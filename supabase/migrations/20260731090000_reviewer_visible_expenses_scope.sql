-- Migration: Canonical role-aware reviewer review scope (DOC-074)
-- Created: 2026-07-31
--
-- Purpose
--   Replace the manager-only pagination RPCs added on 2026-07-30 with a canonical,
--   ROLE-AWARE scope that serves engineer/manager, executive and team_leader reviewers
--   from one shared visibility predicate.
--
-- Why this migration exists in addition to 20260730_1200_*
--   1. 20260730_1200_manager_review_complete_pagination.sql does not begin with a
--      14-digit timestamp, so the Supabase CLI migration runner IGNORES it
--      (see `npm run migrations:check`). It can therefore never be relied upon.
--   2. That migration resolved team visibility only through teams.manager_user_id,
--      which is wrong for executives and team leaders.
--   3. Its count function had no recursion cycle guard, so count and page could
--      disagree (or spin) on a cyclic reporting graph.
--   4. It did not verify that the caller holds an ACTIVE membership in the
--      requested organization, even though it is SECURITY DEFINER.
--
-- Design
--   * A single helper, public.reviewer_visible_user_ids(uuid), owns the whole
--     "whose expenses may this reviewer see" question. Both the count function and
--     the page function call that one helper, so their visibility predicates are
--     identical BY CONSTRUCTION rather than by copy-paste.
--   * SECURITY DEFINER never bypasses authorization: every function re-checks that
--     auth.uid() has an active organization_memberships row for p_organization_id.
--   * Recursion is cycle-safe (visited array) and depth-bounded, with no fixed
--     assumption about how deep the reporting tree is.
--   * expenses.updated_at is NULLABLE, so ordering and the keyset cursor both use
--     COALESCE(updated_at, created_at, epoch). Using the bare column would let rows
--     with a NULL updated_at be skipped permanently by the cursor.
--
-- Idempotent: CREATE OR REPLACE only. Safe to run on a database where the
-- 2026-07-30 functions exist, partially exist, or do not exist at all.

-- ---------------------------------------------------------------------------
-- 0. Shared status set
-- ---------------------------------------------------------------------------
-- Kept inline (rather than a constant) because LANGUAGE sql functions are
-- inlined by the planner and an IN-list is index-friendly.

-- ---------------------------------------------------------------------------
-- 1. reviewer_visible_user_ids — the single source of truth for scope
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reviewer_visible_user_ids(
  p_organization_id uuid
)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE
  -- Authorization gate. Empty when the caller has no ACTIVE membership in this
  -- organization, which makes every downstream CTE empty as well.
  caller AS (
    SELECT om.role
    FROM organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = p_organization_id
      AND om.is_active = true
    LIMIT 1
  ),
  org_profiles AS (
    SELECT p.user_id, p.reporting_engineer_id
    FROM profiles p
    WHERE p.organization_id = p_organization_id
  ),
  -- Full recursive reporting tree beneath auth.uid(), no fixed depth.
  -- `visited` carries the ancestry so a cyclic reporting_engineer_id chain
  -- terminates instead of looping forever.
  reporting_tree AS (
    SELECT
      op.user_id,
      ARRAY[auth.uid(), op.user_id] AS visited
    FROM org_profiles op
    WHERE op.reporting_engineer_id = auth.uid()
      AND EXISTS (SELECT 1 FROM caller)
    UNION ALL
    SELECT
      op.user_id,
      rt.visited || op.user_id
    FROM org_profiles op
    INNER JOIN reporting_tree rt ON op.reporting_engineer_id = rt.user_id
    WHERE NOT (op.user_id = ANY (rt.visited))
      AND array_length(rt.visited, 1) < 64
  ),
  -- Role-aware team visibility. A manager owns teams via manager_user_id, an
  -- executive via executive_user_id, a team leader via team_leader_user_id.
  team_users AS (
    SELECT tm.user_id
    FROM team_members tm
    INNER JOIN teams t ON t.id = tm.team_id
    CROSS JOIN caller c
    WHERE t.organization_id = p_organization_id
      AND tm.organization_id = p_organization_id
      -- role is the app_role ENUM, whose labels are:
      --   admin, engineer, employee, team_leader, executive
      -- There is no 'manager' label — the manager tier is 'engineer' here.
      -- Compared as text so an unknown label can never raise 22P02
      -- (invalid input value for enum app_role) the way a bare enum literal does.
      AND (
        (c.role::text IN ('engineer', 'manager') AND t.manager_user_id     = auth.uid())
        OR (c.role::text = 'executive'           AND t.executive_user_id   = auth.uid())
        OR (c.role::text = 'team_leader'         AND t.team_leader_user_id = auth.uid())
      )
  ),
  candidates AS (
    SELECT rt.user_id FROM reporting_tree rt
    UNION
    SELECT tu.user_id FROM team_users tu
  )
  -- Only users who still hold an ACTIVE membership are in scope.
  SELECT c.user_id
  FROM candidates c
  WHERE EXISTS (
    SELECT 1
    FROM organization_memberships om
    WHERE om.user_id = c.user_id
      AND om.organization_id = p_organization_id
      AND om.is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.reviewer_visible_user_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reviewer_visible_user_ids(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. count_reviewer_visible_expenses
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.count_reviewer_visible_expenses(
  p_organization_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::bigint
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted', 'verified', 'approved', 'rejected', 'edited',
      'under_review', 'level_1_verified', 'level_2_verified'
    )
    -- SECURITY DEFINER must never bypass the membership check.
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
    )
    AND (
      e.user_id IN (SELECT v.user_id FROM public.reviewer_visible_user_ids(p_organization_id) v)
      OR e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      -- Completed / view-only rows this reviewer previously actioned.
      OR EXISTS (
        SELECT 1
        FROM public.audit_logs al
        WHERE al.expense_id = e.id
          AND al.organization_id = p_organization_id
          AND al.user_id = auth.uid()
          AND al.action IN (
            'expense_verified', 'expense_approved', 'tier_advanced', 'expense_rejected'
          )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.count_reviewer_visible_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_reviewer_visible_expenses(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. list_reviewer_visible_expenses_page  (keyset paginated)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_reviewer_visible_expenses_page(
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
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted', 'verified', 'approved', 'rejected', 'edited',
      'under_review', 'level_1_verified', 'level_2_verified'
    )
    -- Identical authorization gate to count_reviewer_visible_expenses.
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
    )
    -- Identical visibility predicate to count_reviewer_visible_expenses.
    AND (
      e.user_id IN (SELECT v.user_id FROM public.reviewer_visible_user_ids(p_organization_id) v)
      OR e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.audit_logs al
        WHERE al.expense_id = e.id
          AND al.organization_id = p_organization_id
          AND al.user_id = auth.uid()
          AND al.action IN (
            'expense_verified', 'expense_approved', 'tier_advanced', 'expense_rejected'
          )
      )
    )
    -- Keyset cursor. The sort expression is repeated verbatim so a row with a
    -- NULL updated_at can never be skipped over by the cursor.
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

REVOKE ALL ON FUNCTION public.list_reviewer_visible_expenses_page(uuid, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_reviewer_visible_expenses_page(uuid, timestamptz, uuid, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Comments
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.reviewer_visible_user_ids(uuid) IS
  'Canonical role-aware review scope: recursive reporting tree beneath auth.uid()
   (cycle-safe) UNION role-appropriate managed-team members, intersected with active
   organization memberships. Returns nothing unless the caller has an active membership.
   Shared by count_reviewer_visible_expenses and list_reviewer_visible_expenses_page so
   the two can never drift apart. Added 2026-07-31 (DOC-074).';

COMMENT ON FUNCTION public.count_reviewer_visible_expenses(uuid) IS
  'Exact total of review expenses visible to auth.uid() in this organization.
   Used to drive truthful "loaded N of TOTAL" progress. Added 2026-07-31 (DOC-074).';

COMMENT ON FUNCTION public.list_reviewer_visible_expenses_page(uuid, timestamptz, uuid, integer) IS
  'Keyset-paginated review expenses for any reviewer role (engineer/manager, executive,
   team_leader). Cursor: (p_after_updated_at, p_after_id) against
   COALESCE(updated_at, created_at, epoch). Order: that expression DESC, id DESC.
   Page size default 250, hard maximum 1000. Returns SETOF public.expenses.
   Added 2026-07-31 (DOC-074).';
