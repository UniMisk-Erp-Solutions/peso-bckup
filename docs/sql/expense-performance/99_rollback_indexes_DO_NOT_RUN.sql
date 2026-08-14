-- ============================================================
-- FILE: 99_rollback_indexes_DO_NOT_RUN.sql
--
-- ████████████████████████████████████████████████████████
-- ██                                                    ██
-- ██   DO NOT RUN THIS FILE UNLESS YOU INTENTIONALLY   ██
-- ██   WANT TO REMOVE THE PERFORMANCE INDEXES.         ██
-- ██                                                    ██
-- ████████████████████████████████████████████████████████
--
-- These are pure read-optimisation indexes — dropping them
-- will NOT change any data or RLS policies.
-- The only consequence is slower expense page loads.
--
-- Reasons to drop: troubleshooting unexpected replication lag,
-- disk space pressure, or rebuilding fresh (re-run 01b after).
--
-- IF EXISTS guards make this safe to run even if indexes are absent.
-- ============================================================

DROP INDEX IF EXISTS public.idx_expenses_user_created;
DROP INDEX IF EXISTS public.idx_expenses_user_updated;
DROP INDEX IF EXISTS public.idx_expenses_batch_org_created;
