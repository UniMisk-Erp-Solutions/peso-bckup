-- Rollback for 20260819177000_balance_ledger_retention.sql
ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_user_id_fkey,
  ADD CONSTRAINT balance_ledger_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
