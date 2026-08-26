-- Rollback for 20260819178000_expense_deductions_employee_read_rpc.sql
DROP FUNCTION IF EXISTS public.get_my_expense_deductions_v1(uuid, integer, integer);
NOTIFY pgrst, 'reload schema';
