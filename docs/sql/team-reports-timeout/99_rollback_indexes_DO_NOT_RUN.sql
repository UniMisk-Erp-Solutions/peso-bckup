-- ============================================================
-- FILE: 99_rollback_indexes_DO_NOT_RUN.sql
--
-- ████████████████████████████████████████████████████████
-- ██                                                    ██
-- ██   DO NOT RUN THIS FILE UNLESS YOU INTENTIONALLY   ██
-- ██   WANT TO REMOVE THE PERFORMANCE INDEXES AND      ██
-- ██   RESTORE THE STATEMENT TIMEOUT ON TEAM REPORTS.  ██
-- ██                                                    ██
-- ████████████████████████████████████████████████████████
--
-- This file exists ONLY as a rollback safety net.
-- These are pure read-optimisation indexes — they do not
-- modify any data, schema, or RLS policies.
-- There is no reason to drop them unless:
--   - You are troubleshooting an unexpected replication lag
--   - You are running out of disk space on a very small instance
--   - You need to rebuild them fresh (just re-run 01b)
--
-- IF NOT EXISTS / IF EXISTS guards make all operations safe to
-- re-run in either direction.
-- ============================================================

-- Drop indexes
DROP INDEX IF EXISTS public.idx_expenses_org_status_created;
DROP INDEX IF EXISTS public.idx_expenses_user_updated;
DROP INDEX IF EXISTS public.idx_expenses_batch_org_created;
DROP INDEX IF EXISTS public.idx_expenses_user_created;

-- Drop RLS policy (may exist from earlier attempt — now largely superseded by the RPC approach)
DROP POLICY IF EXISTS "Team leaders and executives can view team member expenses" ON public.expenses;

-- Drop SECURITY DEFINER RPC (reverts team-scoped expense fetching to broken state)
-- WARNING: Dropping this will restore "No expenses found" for all team-scoped users.
DROP FUNCTION IF EXISTS public.get_team_expenses_for_members(uuid, uuid[], text[], text, text, text, text, int);
