-- Rollback for 20260820100000_shared_financial_authorization_helpers.sql
DROP FUNCTION IF EXISTS public._cashier_target_authorized_v1(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public._legacy_transfer_history_role_v1(text);
NOTIFY pgrst, 'reload schema';
