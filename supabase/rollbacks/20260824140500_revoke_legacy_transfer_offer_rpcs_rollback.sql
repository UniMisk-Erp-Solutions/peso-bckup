-- Rollback for 20260824140500_revoke_legacy_transfer_offer_rpcs.sql
-- Restores the PRE-hardening grant state (re-opens the exposure -- only for
-- emergency use if the revoke unexpectedly breaks something).
BEGIN;

GRANT EXECUTE ON FUNCTION public.propose_balance_transfer_offer(uuid, uuid, numeric, text, uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_balance_transfer_offer(uuid) TO anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
