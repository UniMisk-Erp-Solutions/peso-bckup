-- Rollback for 20260826100000_balance_historical_v2_capabilities.sql
BEGIN;

DROP FUNCTION IF EXISTS public.balance_historical_v2_capabilities_v1();

COMMIT;

NOTIFY pgrst, 'reload schema';
