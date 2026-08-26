-- Rollback for 20260819160000_balance_ledger.sql
-- Safe only if no dependent migration (161000+) has been applied.
DROP TABLE IF EXISTS public.balance_ledger CASCADE;
