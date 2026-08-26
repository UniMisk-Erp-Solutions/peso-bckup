-- Rollback for 20260820120000_balance_transfer_offer_hardening.sql
-- The old propose_balance_transfer_offer / accept_balance_transfer_offer
-- were never modified (ownership prevented CREATE OR REPLACE); only the new
-- _v2 functions this migration added need to be dropped.
DROP FUNCTION IF EXISTS public.propose_balance_transfer_offer_v2(uuid, uuid, decimal, text, uuid, text);
DROP FUNCTION IF EXISTS public.accept_balance_transfer_offer_v2(uuid);
NOTIFY pgrst, 'reload schema';
