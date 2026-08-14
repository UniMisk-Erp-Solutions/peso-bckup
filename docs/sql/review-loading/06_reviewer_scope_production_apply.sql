-- ===========================================================================
-- 06 — Reviewer scope: reviewed Production apply block  (DOC-074)
--
-- ***  NOT EXECUTED BY THIS CHANGE. NOTHING HERE HAS BEEN RUN.  ***
--
-- Order of operations:
--   1. Run 04_reviewer_scope_state_diagnostics.sql   (SELECT-only)
--   2. Run 05_reviewer_scope_index_verification.sql  (SELECT-only)
--   3. Deploy the branch to PREVIEW and validate with the Kunvar account
--   4. Only then paste SECTION A below into the Production SQL editor
--   5. Reload the PostgREST schema cache (SECTION B)
--   6. Create indexes from SECTION C ONLY where step 2 reported
--      covering_index_exists = false
--
-- SECTION A is identical to
--   supabase/migrations/20260731090000_reviewer_visible_expenses_scope.sql
-- and is idempotent: CREATE OR REPLACE only, no DROP, no data change.
-- ===========================================================================


-- ===========================================================================
-- SECTION A — canonical role-aware reviewer scope
-- ===========================================================================
-- Paste the full contents of
--   supabase/migrations/20260731090000_reviewer_visible_expenses_scope.sql
-- here when applying. It is kept in exactly one place on purpose so the file
-- that ships and the text that gets executed can never drift apart.
--
-- It creates:
--   public.reviewer_visible_user_ids(uuid)
--   public.count_reviewer_visible_expenses(uuid)
--   public.list_reviewer_visible_expenses_page(uuid, timestamptz, uuid, integer)
--
-- and REVOKEs PUBLIC / GRANTs authenticated on each.


-- ===========================================================================
-- SECTION B — reload the PostgREST schema cache
-- ===========================================================================
-- Required, otherwise the client keeps receiving PGRST202 "function not found"
-- and silently stays on the legacy paged fallback.
NOTIFY pgrst, 'reload schema';


-- ===========================================================================
-- SECTION C — proposed indexes (create ONLY the ones reported missing)
-- ===========================================================================
-- CONCURRENTLY avoids locking the table, but cannot run inside a transaction
-- block — run each statement on its own, not as part of a BEGIN/COMMIT.
-- Do not create an index that 05_* already reported as covered.

-- Keyset page scan: organization + the exact ordering expression.
-- Expression index because updated_at is nullable and the RPC orders on COALESCE.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_org_keyset
  ON public.expenses (
    organization_id,
    (COALESCE(updated_at, created_at, 'epoch'::timestamptz)) DESC,
    id DESC
  );

-- Scope filter by submitter inside an organization.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_org_user_keyset
  ON public.expenses (
    organization_id,
    user_id,
    (COALESCE(updated_at, created_at, 'epoch'::timestamptz)) DESC,
    id DESC
  );

-- Legacy direct assignments. Partial: the vast majority of rows are NULL here.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_assigned_engineer
  ON public.expenses (assigned_engineer_id)
  WHERE assigned_engineer_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_assigned_reviewer
  ON public.expenses (assigned_reviewer_id)
  WHERE assigned_reviewer_id IS NOT NULL;

-- Recursive reporting-tree walk.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_org_reporting
  ON public.profiles (organization_id, reporting_engineer_id, user_id);

-- Active membership + role resolution (used on every RPC call).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_org_memberships_lookup
  ON public.organization_memberships (organization_id, user_id, is_active, role);

-- Role-aware team ownership. Partial, since each column is set for only one role.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_teams_org_manager
  ON public.teams (organization_id, manager_user_id)
  WHERE manager_user_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_teams_org_executive
  ON public.teams (organization_id, executive_user_id)
  WHERE executive_user_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_teams_org_team_leader
  ON public.teams (organization_id, team_leader_user_id)
  WHERE team_leader_user_id IS NOT NULL;

-- Team membership expansion.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_team_members_org_team_user
  ON public.team_members (organization_id, team_id, user_id);

-- Reviewer history (view-only completed rows).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_reviewer_history
  ON public.audit_logs (organization_id, user_id, action, expense_id);

-- Custom-field enrichment. NOTE: 290706_1900_efv_covering_index.sql may already
-- provide this — check 05_* before creating it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_efv_org_expense
  ON public.expense_form_field_values (organization_id, expense_id);


-- ===========================================================================
-- SECTION D — post-apply verification (SELECT-only)
-- ===========================================================================
-- Re-run 04_* and confirm three rows appear in the function_state check with
-- is_security_definer = true and config = {search_path=public}.
--
-- Then, signed in as the reviewer in the app, the Network tab should show:
--   count_reviewer_visible_expenses          → the authorized total
--   list_reviewer_visible_expenses_page      → p_page_size = 250 per call
-- and no response carrying Content-Range 0-999/*.
