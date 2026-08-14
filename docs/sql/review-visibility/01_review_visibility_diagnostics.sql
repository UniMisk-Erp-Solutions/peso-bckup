-- =============================================================================
-- Review Visibility Diagnostics
-- Branch: feature/user-activity-insights
-- Purpose: Diagnose which expenses a manager/executive/team-leader should
--          see vs. what they actually see, and identify gaps.
--
-- DO NOT EXECUTE IN PRODUCTION without a read-only connection.
-- All queries are SELECT-only.
-- =============================================================================

-- Replace these placeholders before running:
--   :org_id        — organization UUID
--   :manager_id    — the manager/executive user UUID under investigation

-- ---------------------------------------------------------------------------
-- 1. Full recursive reporting chain under a given manager
--    Shows every descendant (executive → TL → employee) via recursive CTE.
-- ---------------------------------------------------------------------------
WITH RECURSIVE reporting_tree AS (
  -- Anchor: direct reports
  SELECT
    p.user_id,
    p.reporting_engineer_id AS manager_id,
    om.role,
    1 AS depth,
    ARRAY[p.user_id] AS path
  FROM profiles p
  JOIN organization_memberships om ON om.user_id = p.user_id
    AND om.organization_id = p.organization_id
    AND om.is_active = true
  WHERE p.organization_id = :org_id
    AND p.reporting_engineer_id = :manager_id

  UNION ALL

  -- Recursive: reports of reports
  SELECT
    p.user_id,
    p.reporting_engineer_id,
    om.role,
    rt.depth + 1,
    rt.path || p.user_id
  FROM profiles p
  JOIN organization_memberships om ON om.user_id = p.user_id
    AND om.organization_id = p.organization_id
    AND om.is_active = true
  JOIN reporting_tree rt ON rt.user_id = p.reporting_engineer_id
  WHERE p.organization_id = :org_id
    AND NOT (p.user_id = ANY(rt.path))  -- cycle guard
    AND rt.depth < 10                    -- safety depth cap
)
SELECT
  rt.user_id,
  rt.role,
  rt.depth,
  rt.manager_id AS reports_to,
  p.full_name
FROM reporting_tree rt
LEFT JOIN profiles p ON p.user_id = rt.user_id
ORDER BY rt.depth, rt.role;


-- ---------------------------------------------------------------------------
-- 2. Formal team membership (teams.manager_user_id path)
-- ---------------------------------------------------------------------------
SELECT
  tm.user_id,
  tm.team_id,
  t.name AS team_name,
  om.role
FROM teams t
JOIN team_members tm ON tm.team_id = t.id
JOIN organization_memberships om ON om.user_id = tm.user_id
  AND om.organization_id = t.organization_id
  AND om.is_active = true
WHERE t.organization_id = :org_id
  AND t.manager_user_id = :manager_id;


-- ---------------------------------------------------------------------------
-- 3. Expenses visible to the manager via reporting hierarchy
--    (direct + all recursive descendants)
-- ---------------------------------------------------------------------------
WITH RECURSIVE reporting_tree AS (
  SELECT p.user_id, ARRAY[p.user_id] AS path, 1 AS depth
  FROM profiles p
  WHERE p.organization_id = :org_id
    AND p.reporting_engineer_id = :manager_id
  UNION ALL
  SELECT p.user_id, rt.path || p.user_id, rt.depth + 1
  FROM profiles p
  JOIN reporting_tree rt ON rt.user_id = p.reporting_engineer_id
  WHERE p.organization_id = :org_id
    AND NOT (p.user_id = ANY(rt.path))
    AND rt.depth < 10
)
SELECT
  e.id AS expense_id,
  e.user_id AS submitter_id,
  e.status,
  e.approval_tier,
  e.assigned_reviewer_id,
  e.assigned_engineer_id,
  e.amount,
  e.updated_at
FROM expenses e
JOIN reporting_tree rt ON rt.user_id = e.user_id
WHERE e.organization_id = :org_id
  AND e.status IN (
    'submitted','verified','approved','rejected','edited',
    'under_review','level_1_verified','level_2_verified'
  )
ORDER BY e.updated_at DESC;


-- ---------------------------------------------------------------------------
-- 4. Expenses that are at the manager's actionable tier
--    (expenses in the hierarchy that the manager should act on NOW)
-- ---------------------------------------------------------------------------
WITH RECURSIVE reporting_tree AS (
  SELECT p.user_id, ARRAY[p.user_id] AS path, 1 AS depth
  FROM profiles p
  WHERE p.organization_id = :org_id
    AND p.reporting_engineer_id = :manager_id
  UNION ALL
  SELECT p.user_id, rt.path || p.user_id, rt.depth + 1
  FROM profiles p
  JOIN reporting_tree rt ON rt.user_id = p.reporting_engineer_id
  WHERE p.organization_id = :org_id
    AND NOT (p.user_id = ANY(rt.path))
    AND rt.depth < 10
)
SELECT
  e.id AS expense_id,
  e.status,
  e.approval_tier,
  e.assigned_reviewer_id,
  om_manager.role AS manager_role
FROM expenses e
JOIN reporting_tree rt ON rt.user_id = e.user_id
JOIN organization_memberships om_manager ON om_manager.user_id = :manager_id
  AND om_manager.organization_id = :org_id
  AND om_manager.is_active = true
WHERE e.organization_id = :org_id
  AND e.assigned_reviewer_id = :manager_id;


-- ---------------------------------------------------------------------------
-- 5. Gap analysis: expenses visible via hierarchy but NOT returned by
--    the current list_manager_reviewer_expenses RPC
--    (helps confirm whether the RPC itself needs updating)
-- ---------------------------------------------------------------------------
WITH RECURSIVE reporting_tree AS (
  SELECT p.user_id, ARRAY[p.user_id] AS path, 1 AS depth
  FROM profiles p
  WHERE p.organization_id = :org_id
    AND p.reporting_engineer_id = :manager_id
  UNION ALL
  SELECT p.user_id, rt.path || p.user_id, rt.depth + 1
  FROM profiles p
  JOIN reporting_tree rt ON rt.user_id = p.reporting_engineer_id
  WHERE p.organization_id = :org_id
    AND NOT (p.user_id = ANY(rt.path))
    AND rt.depth < 10
),
rpc_expenses AS (
  SELECT * FROM list_manager_reviewer_expenses(:org_id)
),
hierarchy_expenses AS (
  SELECT e.id
  FROM expenses e
  JOIN reporting_tree rt ON rt.user_id = e.user_id
  WHERE e.organization_id = :org_id
    AND e.status IN (
      'submitted','verified','approved','rejected','edited',
      'under_review','level_1_verified','level_2_verified'
    )
)
SELECT
  he.id AS expense_id,
  'missing from RPC' AS gap_type
FROM hierarchy_expenses he
WHERE he.id NOT IN (SELECT id FROM rpc_expenses)

UNION ALL

SELECT
  re.id,
  'in RPC but not in hierarchy (direct assignment?)' AS gap_type
FROM rpc_expenses re
WHERE re.id NOT IN (SELECT id FROM hierarchy_expenses)
ORDER BY gap_type, expense_id;


-- ---------------------------------------------------------------------------
-- 6. Summary counts per status for the manager's visible expenses
-- ---------------------------------------------------------------------------
WITH RECURSIVE reporting_tree AS (
  SELECT p.user_id, ARRAY[p.user_id] AS path, 1 AS depth
  FROM profiles p
  WHERE p.organization_id = :org_id
    AND p.reporting_engineer_id = :manager_id
  UNION ALL
  SELECT p.user_id, rt.path || p.user_id, rt.depth + 1
  FROM profiles p
  JOIN reporting_tree rt ON rt.user_id = p.reporting_engineer_id
  WHERE p.organization_id = :org_id
    AND NOT (p.user_id = ANY(rt.path))
    AND rt.depth < 10
)
SELECT
  e.status,
  e.approval_tier,
  COUNT(*) AS expense_count
FROM expenses e
JOIN reporting_tree rt ON rt.user_id = e.user_id
WHERE e.organization_id = :org_id
  AND e.status IN (
    'submitted','verified','approved','rejected','edited',
    'under_review','level_1_verified','level_2_verified'
  )
GROUP BY e.status, e.approval_tier
ORDER BY e.status, e.approval_tier;
