-- =============================================================================
-- 01_review_expense_completeness_diagnostics.sql
-- SELECT-ONLY diagnostics for the manager review expense loading pipeline.
-- Replace :organization_id and :reviewer_user_id with real UUIDs before running.
-- DO NOT run EXPLAIN ANALYZE or any mutating SQL here.
-- =============================================================================

-- A. ORGANIZATION TOTALS
-- How many expenses exist in this org at reviewable statuses?
SELECT
  status,
  COUNT(*) AS expense_count,
  SUM(total_amount) AS total_amount
FROM expenses
WHERE organization_id = ':organization_id'
  AND status IN (
    'submitted', 'verified', 'approved', 'rejected', 'edited',
    'under_review', 'level_1_verified', 'level_2_verified'
  )
GROUP BY status
ORDER BY expense_count DESC;

-- B. RECURSIVE REPORTING TREE (WITH RECURSIVE, cycle detection)
-- Who reports (directly or transitively) to :reviewer_user_id?
WITH RECURSIVE reporting_tree AS (
  -- Base: direct reports
  SELECT
    p.user_id,
    p.name,
    1 AS depth,
    ARRAY[':reviewer_user_id'::uuid] AS visited
  FROM profiles p
  WHERE p.organization_id = ':organization_id'
    AND p.reporting_engineer_id = ':reviewer_user_id'

  UNION ALL

  -- Recursive: next level
  SELECT
    p.user_id,
    p.name,
    rt.depth + 1,
    rt.visited || p.user_id
  FROM profiles p
  INNER JOIN reporting_tree rt ON p.reporting_engineer_id = rt.user_id
  WHERE p.organization_id = ':organization_id'
    AND NOT (p.user_id = ANY(rt.visited))  -- cycle guard
    AND rt.depth < 20                       -- sanity depth cap
)
SELECT user_id, name, depth
FROM reporting_tree
ORDER BY depth, name;

-- C. ACTIVE MEMBERSHIPS for reporting-tree members
SELECT om.user_id, p.name, om.role, om.is_active
FROM organization_memberships om
LEFT JOIN profiles p ON p.user_id = om.user_id AND p.organization_id = ':organization_id'
WHERE om.organization_id = ':organization_id'
  AND om.is_active = true
ORDER BY om.role, p.name;

-- D. TEAM VISIBILITY — which teams does :reviewer_user_id manage (any role)?
-- teams has: team_leader_user_id, executive_user_id, manager_user_id — NO manager_id column.
SELECT
  t.id AS team_id,
  t.name AS team_name,
  CASE
    WHEN t.team_leader_user_id = ':reviewer_user_id' THEN 'team_leader'
    WHEN t.executive_user_id   = ':reviewer_user_id' THEN 'executive'
    WHEN t.manager_user_id     = ':reviewer_user_id' THEN 'manager'
  END AS role_in_team,
  COUNT(tm.user_id) AS member_count
FROM teams t
LEFT JOIN team_members tm ON tm.team_id = t.id
WHERE t.organization_id = ':organization_id'
  AND (
    t.team_leader_user_id = ':reviewer_user_id'
    OR t.executive_user_id   = ':reviewer_user_id'
    OR t.manager_user_id     = ':reviewer_user_id'
  )
GROUP BY t.id, t.name, role_in_team
ORDER BY t.name;

-- E. CANONICAL VISIBLE USERS (union of reporting + team + direct assignments)
WITH RECURSIVE reporting_tree AS (
  SELECT p.user_id
  FROM profiles p
  WHERE p.organization_id = ':organization_id'
    AND p.reporting_engineer_id = ':reviewer_user_id'
  UNION ALL
  SELECT p.user_id
  FROM profiles p
  INNER JOIN reporting_tree rt ON p.reporting_engineer_id = rt.user_id
  WHERE p.organization_id = ':organization_id'
),
team_users AS (
  SELECT tm.user_id
  FROM team_members tm
  INNER JOIN teams t ON t.id = tm.team_id
  WHERE t.organization_id = ':organization_id'
    AND (
      t.team_leader_user_id = ':reviewer_user_id'
      OR t.executive_user_id   = ':reviewer_user_id'
      OR t.manager_user_id     = ':reviewer_user_id'
    )
),
visible AS (
  SELECT user_id, 'reporting_tree' AS source FROM reporting_tree
  UNION
  SELECT user_id, 'team'           AS source FROM team_users
)
SELECT v.user_id, p.name, string_agg(v.source, ', ') AS visibility_sources
FROM visible v
LEFT JOIN profiles p ON p.user_id = v.user_id AND p.organization_id = ':organization_id'
GROUP BY v.user_id, p.name
ORDER BY p.name;

-- F. EXPECTED VISIBLE EXPENSE COUNT (canonical, no RPC)
WITH RECURSIVE reporting_tree AS (
  SELECT user_id FROM profiles
  WHERE organization_id = ':organization_id'
    AND reporting_engineer_id = ':reviewer_user_id'
  UNION ALL
  SELECT p.user_id FROM profiles p
  INNER JOIN reporting_tree rt ON p.reporting_engineer_id = rt.user_id
  WHERE p.organization_id = ':organization_id'
),
team_users AS (
  SELECT tm.user_id FROM team_members tm
  INNER JOIN teams t ON t.id = tm.team_id
  WHERE t.organization_id = ':organization_id'
    AND (
      t.team_leader_user_id = ':reviewer_user_id'
      OR t.executive_user_id   = ':reviewer_user_id'
      OR t.manager_user_id     = ':reviewer_user_id'
    )
),
visible AS (
  SELECT user_id FROM reporting_tree
  UNION
  SELECT user_id FROM team_users
)
SELECT COUNT(*) AS canonical_visible_expense_count
FROM expenses e
WHERE e.organization_id = ':organization_id'
  AND e.status IN (
    'submitted', 'verified', 'approved', 'rejected', 'edited',
    'under_review', 'level_1_verified', 'level_2_verified'
  )
  AND (
    e.user_id IN (SELECT user_id FROM visible)
    OR e.assigned_engineer_id = ':reviewer_user_id'
    OR e.assigned_reviewer_id = ':reviewer_user_id'
  );

-- G. CURRENT RPC COUNTS — what does the existing RPC return vs. canonical?
-- NOTE: Replace with actual RPC call syntax as needed.
-- SELECT COUNT(*) FROM list_manager_pending_expenses(':organization_id');

-- H. MISSING EXPENSE IDS (in canonical but not returned by RPC)
-- Run canonical query (F) to a temp CTE and compare with RPC output manually.
-- Example template (fill in RPC results):
-- SELECT canonical.id
-- FROM (
--   SELECT e.id FROM expenses e WHERE ... [canonical filter from F]
-- ) canonical
-- LEFT JOIN (
--   SELECT id FROM list_manager_pending_expenses(':organization_id')
-- ) rpc ON rpc.id = canonical.id
-- WHERE rpc.id IS NULL;

-- I. INDEX VERIFICATION
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'expenses', 'profiles', 'organization_memberships',
    'team_members', 'teams', 'audit_logs',
    'expense_form_field_values'
  )
ORDER BY tablename, indexname;

-- J. TABLE STATISTICS
SELECT
  schemaname,
  relname AS tablename,
  n_live_tup AS live_rows,
  n_dead_tup AS dead_rows,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND relname IN (
    'expenses', 'profiles', 'organization_memberships',
    'team_members', 'teams', 'audit_logs',
    'expense_form_field_values'
  )
ORDER BY relname;

-- K. SAFE QUERY PLAN NOTES
-- To investigate slow queries, run the following in a development DB ONLY:
--   EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT ...
-- Do NOT run EXPLAIN ANALYZE on production; it executes the query and may
-- cause timeouts or lock contention. Use pg_stat_statements instead:
SELECT
  query,
  calls,
  total_exec_time / 1000.0 AS total_exec_sec,
  mean_exec_time / 1000.0  AS mean_exec_sec,
  rows
FROM pg_stat_statements
WHERE query ILIKE '%list_manager_pending_expenses%'
   OR query ILIKE '%list_hierarchy_reviewer_expenses%'
   OR query ILIKE '%list_manager_visible_review_expenses%'
ORDER BY total_exec_time DESC
LIMIT 20;
