-- Historical Balance Anchors V2 -- financial-history completeness hardening.
--
-- NOT APPLIED TO PRODUCTION. Prepared for owner/DBA review per this task's
-- explicit instruction; requires separate authorization before running.
--
-- ===========================================================================
-- peso-bckup IMPORT NOTE -- APPLY THIS ONE LAST, AFTER THE FRONTEND DEPLOY.
--
-- Renamed from 20260824140000 on import: that version prefix was already
-- taken here by 20260824140000_admin_bulk_submit_expenses_for_employees.sql.
--
-- The "confirmed safe to revoke" argument below is about the NEW bundle. It
-- does not hold for the bundle currently serving peso-backup.vercel.app,
-- which is the pre-import code and DOES call the bare
-- propose_balance_transfer_offer / accept_balance_transfer_offer. Applying
-- this before the new frontend is live breaks bank-transfer offers on the
-- running site with "permission denied for function".
--
-- Correct order here: apply every other migration -> deploy the frontend ->
-- confirm transfers work on the v2 RPCs -> only then apply this file.
--
-- Also note its premise below is wrong for THIS repository: it assumes these
-- functions are owned by supabase_admin and unreplaceable, but
-- 290529_1600_fix_propose_balance_transfer_offer_v_bank.sql and
-- 290529_1700_cashier_accountant_mode.sql both CREATE OR REPLACE them here
-- successfully, so we own them and the REVOKE will apply cleanly.
--
-- Finally: those two 290529_* files GRANT EXECUTE on the legacy functions and
-- sort lexicographically AFTER every 2026* migration ('9' > '0' at position
-- two). On an incremental apply to the live database -- what we are doing --
-- the revoke sticks. On a from-scratch replay it would be silently undone.
-- ===========================================================================
--
-- Read-only audit (2026-08-24, this session) re-confirmed live on
-- Production: propose_balance_transfer_offer / accept_balance_transfer_offer
-- (the pre-v2 functions) still carry
--   anon=X/supabase_admin, authenticated=X/supabase_admin
-- in their live ACL -- i.e. an UNAUTHENTICATED client can call them over
-- PostgREST today. Both write directly to profiles.balance /
-- cash_transfer_history / money_assignments with ZERO balance_ledger
-- evidence (confirmed by grep: neither function's defining migration
-- contains an INSERT INTO balance_ledger). Any balance change these
-- functions ever produced or could produce is INVISIBLE to
-- _balance_historical_position_before_v1's reconstruction -- which sums
-- only balance_ledger and expense_balance_deductions -- silently
-- corrupting the accuracy of every historical anchor's calculated
-- adjustment computed from that point forward. This is exactly the
-- "unledgered mutation path that can invalidate historical replay" this
-- task's audit section asked to either close or explicitly flag.
--
-- Confirmed safe to revoke: `rg '"propose_balance_transfer_offer"|"accept_balance_transfer_offer"' src/`
-- returns zero matches -- no frontend code on this branch calls either bare
-- (non-_v2) name. BalanceTransferOfferService.ts already calls
-- propose_balance_transfer_offer_v2 / accept_balance_transfer_offer_v2
-- exclusively (DOC-103 rev 6.0, 2026-08-20).
--
-- Why REVOKE only, not DROP: the v1 functions predate this session's DDL
-- role (owned by supabase_admin) and cannot be replaced/dropped by the
-- postgres role this session's other migrations run as -- confirmed by the
-- prior balance-system audit. Revoking EXECUTE closes the exposure without
-- requiring ownership changes; the function bodies remain for forensic
-- reference (e.g. if an old transfer needs auditing) but become
-- unreachable via PostgREST/RPC from any client role.
--
-- Rollout order: apply ONLY after independently confirming (read-only,
-- against the actual target environment, not just this branch's source)
-- that no other deployed frontend build/version still calls either bare
-- name -- a stale cached bundle on an old Vercel preview or a mobile client
-- pinned to an older release could still reference them.

BEGIN;

REVOKE ALL ON FUNCTION public.propose_balance_transfer_offer(uuid, uuid, numeric, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.propose_balance_transfer_offer(uuid, uuid, numeric, text, uuid, text) FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.accept_balance_transfer_offer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_balance_transfer_offer(uuid) FROM anon, authenticated;

COMMENT ON FUNCTION public.propose_balance_transfer_offer(uuid, uuid, numeric, text, uuid, text) IS
  'DEPRECATED 2026-08-24 -- superseded by propose_balance_transfer_offer_v2, '
  'which writes balance_ledger evidence this function never did. EXECUTE '
  'revoked from anon/authenticated (financial-history completeness '
  'hardening); body retained for forensic reference only. Owner-approved '
  'removal from the exposure surface -- see this migration''s header.';

COMMENT ON FUNCTION public.accept_balance_transfer_offer(uuid) IS
  'DEPRECATED 2026-08-24 -- superseded by accept_balance_transfer_offer_v2, '
  'which writes balance_ledger evidence this function never did. EXECUTE '
  'revoked from anon/authenticated (financial-history completeness '
  'hardening); body retained for forensic reference only. Owner-approved '
  'removal from the exposure surface -- see this migration''s header.';

COMMIT;

NOTIFY pgrst, 'reload schema';
