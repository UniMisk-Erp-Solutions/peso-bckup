-- Rollback for 20260819164000_balance_import_validate_and_storage.sql
DROP FUNCTION IF EXISTS public.balance_validate_import_v1(uuid);
DROP POLICY IF EXISTS "Admins upload own org import archive" ON storage.objects;
DROP POLICY IF EXISTS "Admins read own org import archive" ON storage.objects;
DELETE FROM storage.buckets WHERE id = 'balance-import-archive';
NOTIFY pgrst, 'reload schema';
