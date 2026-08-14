-- =============================================================================
-- 03_review_expense_indexes_proposed.sql
-- Proposed indexes for the review expense loading pipeline.
--
-- LOCKING IMPLICATIONS:
--   All statements use CREATE INDEX CONCURRENTLY which does NOT hold an
--   ACCESS EXCLUSIVE lock for the full build duration. It uses two passes:
--   1. Build without lock (reads table, builds index snapshot).
--   2. Merge concurrent changes (brief ShareUpdateExclusiveLock).
--   The table remains writable and readable throughout.
--   Transactions are NOT supported — run each statement independently.
--   Concurrent index builds can be safely cancelled via pg_cancel_backend().
--
-- DO NOT execute this file automatically in a migration.
-- Review each index with the DBA, confirm it does not already exist
-- (run 02_review_expense_index_verification.sql first), then apply manually.
-- =============================================================================

-- 1. expense_form_field_values — org + expense lookup with covering columns
--    Used by: fetchValueRowsForExpenseBatch (custom field enrichment)
--    Eliminates seq-scan on large orgs when querying by expense IDs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_effv_org_expense_covering
ON expense_form_field_values (organization_id, expense_id)
INCLUDE (field_value, template_id, branch_field_id);

-- 2. expenses — org + updated_at DESC + id DESC keyset cursor
--    Used by: list_manager_visible_review_expenses_page (new RPC, keyset pagination)
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_expenses_org_updated_at_id
ON expenses (organization_id, updated_at DESC, id DESC);

-- 3. expenses — org + status (review status filter, count query)
--    Used by: count_manager_visible_review_expenses, list_manager_pending_expenses
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_expenses_org_status
ON expenses (organization_id, status);

-- 4. expenses — partial index for assigned_engineer_id (direct assignment visibility)
--    Only indexes rows where assigned_engineer_id is set (partial = much smaller).
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_expenses_assigned_engineer_status
ON expenses (organization_id, assigned_engineer_id, status)
WHERE assigned_engineer_id IS NOT NULL;

-- 5. expenses — partial index for assigned_reviewer_id (direct reviewer assignment)
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_expenses_assigned_reviewer_status
ON expenses (organization_id, assigned_reviewer_id, status)
WHERE assigned_reviewer_id IS NOT NULL;

-- 6. profiles — org + reporting_engineer_id (recursive tree CTE base case)
--    Used by: WITH RECURSIVE reporting_tree in review RPCs
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_profiles_org_reporting_engineer
ON profiles (organization_id, reporting_engineer_id, user_id);

-- 7. organization_memberships — org + user_id + is_active + role
--    Used by: active_members CTE, visibility checks
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_org_memberships_org_user_active
ON organization_memberships (organization_id, user_id, is_active, role);

-- 8. audit_logs — org + action + expense_id with covering columns
--    Used by: fetchResubmittedExpenseIds fallback (audit_logs query)
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_audit_logs_org_action_expense
ON audit_logs (organization_id, action, expense_id)
INCLUDE (user_id, created_at);

-- 9. team_members — team_id for join from teams → team_members
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_team_members_team_id
ON team_members (team_id, user_id);

-- 10. teams — org + manager_user_id (team visibility for engineer/manager role reviewer)
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_teams_org_manager
ON teams (organization_id, manager_user_id);

-- =============================================================================
-- Post-creation verification (run after each index is created):
-- =============================================================================
-- SELECT indexname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
-- FROM pg_stat_user_indexes
-- WHERE indexname IN (
--   'idx_effv_org_expense_covering',
--   'idx_expenses_org_updated_at_id',
--   'idx_expenses_org_status',
--   'idx_expenses_assigned_engineer_status',
--   'idx_expenses_assigned_reviewer_status',
--   'idx_profiles_org_reporting_engineer',
--   'idx_org_memberships_org_user_active',
--   'idx_audit_logs_org_action_expense',
--   'idx_team_members_team_id',
--   'idx_teams_org_manager'
-- );
