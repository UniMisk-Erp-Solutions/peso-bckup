-- Rollback for 20260820140000_balance_import_delete_protection.sql
GRANT DELETE ON public.balance_import_batches TO authenticated;
GRANT DELETE ON public.balance_import_rows TO authenticated;
DROP FUNCTION IF EXISTS public.balance_cancel_draft_import_v1(uuid);
NOTIFY pgrst, 'reload schema';
