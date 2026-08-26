-- Rollback for 20260819163000_balance_import_apply_rpc.sql
DROP FUNCTION IF EXISTS public.balance_apply_import_v1(uuid);
DROP FUNCTION IF EXISTS public.balance_reverse_import_v1(uuid, text);
NOTIFY pgrst, 'reload schema';
