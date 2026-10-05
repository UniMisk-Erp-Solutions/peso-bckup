-- Rollback for 20260826110000_balance_reverse_import_v2.sql
BEGIN;

DROP FUNCTION IF EXISTS public.balance_reverse_import_v2(uuid, text);

COMMIT;

NOTIFY pgrst, 'reload schema';
