-- Rollback for 20260820150000_unified_employee_balance_history_v1.sql
DROP FUNCTION IF EXISTS public.get_my_unified_balance_history_v1(uuid, integer, integer);
NOTIFY pgrst, 'reload schema';
