-- Rollback for 20260819161000_balance_manual_rpcs.sql
DROP FUNCTION IF EXISTS public.balance_add_funds_v1(uuid, numeric, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.balance_adjust_v1(uuid, numeric, text);
NOTIFY pgrst, 'reload schema';
