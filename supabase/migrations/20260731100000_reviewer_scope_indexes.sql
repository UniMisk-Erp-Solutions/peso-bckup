-- Migration: Supporting indexes for the reviewer review scope (DOC-074)
-- Created: 2026-07-31
--
-- Why: EXPLAIN on the page query showed a Seq Scan over ~7,164 rows plus a Sort:
--
--   Limit  (cost=935.35..935.97 rows=250 width=263)
--     ->  Sort  (cost=935.35..953.26 rows=7164 width=263)
--           Sort Key: (COALESCE(updated_at, created_at, '1970-01-01...')) DESC, id DESC
--           ->  Seq Scan on expenses e  (cost=0.00..614.19 rows=7164 width=263)
--
-- That is tolerable at 7k rows and degrades badly as the table grows, because
-- every keyset page re-sorts the whole organization.
--
-- NOTE ON `CONCURRENTLY`: deliberately NOT used here. The Supabase CLI runs each
-- migration inside a transaction, and CREATE INDEX CONCURRENTLY cannot run in a
-- transaction block (SQLSTATE 25001). These tables are small enough that the
-- brief lock is not a concern. To build without any lock on a large table, run
-- the equivalent statements manually via psql with CONCURRENTLY added.
--
-- All statements are IF NOT EXISTS, so this is safe to re-run and safe on a
-- database where some of these indexes were already created by hand.

-- ---------------------------------------------------------------------------
-- expenses — keyset page scan
-- Expression index: the ORDER BY uses COALESCE(updated_at, created_at, epoch)
-- because expenses.updated_at is nullable, so a plain (organization_id,
-- updated_at, id) index would not satisfy the sort.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_expenses_org_keyset
  ON public.expenses (
    organization_id,
    (COALESCE(updated_at, created_at, 'epoch'::timestamptz)) DESC,
    id DESC
  );

-- Scope filter by submitter within an organization.
CREATE INDEX IF NOT EXISTS idx_expenses_org_user_keyset
  ON public.expenses (
    organization_id,
    user_id,
    (COALESCE(updated_at, created_at, 'epoch'::timestamptz)) DESC,
    id DESC
  );

-- Legacy direct assignments. Partial — most rows are NULL in these columns.
CREATE INDEX IF NOT EXISTS idx_expenses_assigned_engineer
  ON public.expenses (assigned_engineer_id)
  WHERE assigned_engineer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_assigned_reviewer
  ON public.expenses (assigned_reviewer_id)
  WHERE assigned_reviewer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- profiles — recursive reporting-tree walk in reviewer_visible_user_ids
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_profiles_org_reporting
  ON public.profiles (organization_id, reporting_engineer_id, user_id);

-- ---------------------------------------------------------------------------
-- organization_memberships — active membership + role, hit on every RPC call
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_org_memberships_lookup
  ON public.organization_memberships (organization_id, user_id, is_active, role);

-- ---------------------------------------------------------------------------
-- teams — role-aware ownership. Partial: each column is set for one role only.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_teams_org_manager
  ON public.teams (organization_id, manager_user_id)
  WHERE manager_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_teams_org_executive
  ON public.teams (organization_id, executive_user_id)
  WHERE executive_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_teams_org_team_leader
  ON public.teams (organization_id, team_leader_user_id)
  WHERE team_leader_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- team_members — team membership expansion
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_team_members_org_team_user
  ON public.team_members (organization_id, team_id, user_id);

-- ---------------------------------------------------------------------------
-- audit_logs — reviewer history (view-only completed rows)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_logs_reviewer_history
  ON public.audit_logs (organization_id, user_id, action, expense_id);

-- Refresh planner statistics so the new indexes are costed correctly straight away.
ANALYZE public.expenses;
ANALYZE public.profiles;
ANALYZE public.organization_memberships;
