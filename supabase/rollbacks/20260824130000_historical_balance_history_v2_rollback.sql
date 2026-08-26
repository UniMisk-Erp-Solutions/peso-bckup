-- Rollback for 20260824130000_historical_balance_history_v2.sql
BEGIN;

DROP FUNCTION IF EXISTS public.get_org_balance_ledger_v2(uuid, uuid, integer, integer);
DROP FUNCTION IF EXISTS public.get_my_unified_balance_history_v2(uuid, integer, integer);

COMMIT;

NOTIFY pgrst, 'reload schema';
