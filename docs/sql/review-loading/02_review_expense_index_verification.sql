-- =============================================================================
-- 02_review_expense_index_verification.sql
-- SELECT-ONLY checks for required indexes on the review expense loading path.
-- Run this before applying 03_review_expense_indexes_proposed.sql to identify gaps.
-- =============================================================================

-- Check for each required index by table and approximate column pattern.
-- A row in the result means the index EXISTS; a missing row is a gap.

SELECT
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND (
    -- expense_form_field_values: org + expense covering index
    (tablename = 'expense_form_field_values'
      AND indexdef ILIKE '%organization_id%expense_id%')

    -- expenses: org + updated_at DESC keyset cursor
    OR (tablename = 'expenses'
      AND indexdef ILIKE '%organization_id%updated_at%')

    -- expenses: org + status (for review status filter)
    OR (tablename = 'expenses'
      AND indexdef ILIKE '%organization_id%status%')

    -- profiles: org + reporting_engineer_id (recursive tree)
    OR (tablename = 'profiles'
      AND indexdef ILIKE '%organization_id%reporting_engineer_id%')

    -- organization_memberships: org + user_id + is_active
    OR (tablename = 'organization_memberships'
      AND indexdef ILIKE '%organization_id%user_id%is_active%')

    -- audit_logs: org + action + expense_id (resubmission queries)
    OR (tablename = 'audit_logs'
      AND indexdef ILIKE '%organization_id%action%expense_id%')

    -- team_members: team_id
    OR (tablename = 'team_members'
      AND indexdef ILIKE '%team_id%')

    -- teams: org + manager_user_id
    OR (tablename = 'teams'
      AND indexdef ILIKE '%organization_id%manager_user_id%')
  )
ORDER BY tablename, indexname;

-- Summary: which required indexes are MISSING?
-- Compare the count below against the expected 8 patterns above.
SELECT COUNT(*) AS matching_index_count FROM pg_indexes
WHERE schemaname = 'public'
  AND (
    (tablename = 'expense_form_field_values' AND indexdef ILIKE '%organization_id%expense_id%')
    OR (tablename = 'expenses' AND indexdef ILIKE '%organization_id%updated_at%')
    OR (tablename = 'expenses' AND indexdef ILIKE '%organization_id%status%')
    OR (tablename = 'profiles' AND indexdef ILIKE '%organization_id%reporting_engineer_id%')
    OR (tablename = 'organization_memberships' AND indexdef ILIKE '%organization_id%user_id%is_active%')
    OR (tablename = 'audit_logs' AND indexdef ILIKE '%organization_id%action%expense_id%')
    OR (tablename = 'team_members' AND indexdef ILIKE '%team_id%')
    OR (tablename = 'teams' AND indexdef ILIKE '%organization_id%manager_id%')
  );
-- Expected: 8. If less, the missing entries need the indexes from file 03.

-- Check index bloat (large dead-tuple ratio suggests REINDEX may help)
SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'expenses', 'profiles', 'organization_memberships',
    'team_members', 'teams', 'audit_logs', 'expense_form_field_values'
  )
ORDER BY pg_relation_size(indexrelid) DESC;
