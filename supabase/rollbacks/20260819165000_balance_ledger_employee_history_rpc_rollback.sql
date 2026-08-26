-- Rollback for 20260819165000_balance_ledger_employee_history_rpc.sql
DROP FUNCTION IF EXISTS public.get_my_balance_ledger_v1(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.get_org_balance_ledger_v1(uuid, uuid, integer, integer);
NOTIFY pgrst, 'reload schema';
