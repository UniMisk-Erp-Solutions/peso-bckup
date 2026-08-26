-- Rollback for 20260819176000_balance_import_staging_grants.sql
GRANT INSERT, UPDATE ON public.balance_import_batches TO authenticated;
GRANT INSERT, UPDATE ON public.balance_import_rows TO authenticated;
NOTIFY pgrst, 'reload schema';
