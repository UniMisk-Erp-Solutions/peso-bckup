-- ---------------------------------------------------------------------------
-- DOC-111 / DOC-112 prerequisite -- money table organization_id columns
--
-- Written for peso-bckup on import of the balance ledger / bulk import /
-- historical anchors feature. It is NOT part of the imported set: it closes a
-- gap between the schema those migrations were authored against and this one.
--
-- Five of the imported migrations write organization_id into
-- money_assignments:
--   20260819161000_balance_manual_rpcs.sql
--   20260819170000_balance_manual_rpc_hardening.sql
--   20260819172000_balance_cashier_location_authorization.sql
--   20260820110000_balance_add_funds_shared_scope_bank_and_role_fix.sql
--   20260820120000_balance_transfer_offer_hardening.sql
-- and 20260820130000_money_return_approve_v2.sql reads
-- money_return_requests.organization_id.
--
-- Neither column exists here: money_assignments comes from
-- 20250118000001_track_money_assignments.sql without it, and this repository
-- carries 20260423130000_fix_money_return_requests_rls_without_org_column.sql,
-- whose name records the same absence for money_return_requests.
--
-- Those writes live inside plpgsql function bodies, so Postgres does not
-- resolve them at CREATE FUNCTION time. Without this migration the imported
-- set applies with no error and then fails at RUNTIME on the first cashier
-- cash add, the first transfer-offer acceptance, and the first money-return
-- approval, with: column "organization_id" of relation "money_assignments"
-- does not exist. The failing INSERT shares a transaction with the
-- profiles.balance UPDATE, so no money is half-moved -- but every one of those
-- flows is dead until this runs.
--
-- Runs before 20260819160000_balance_ledger.sql. Fully idempotent.
--
-- DELIBERATELY NULLABLE. cash_transfer_history took NOT NULL in
-- 20250130000000, but money_assignments cannot: the pre-existing
-- accept_balance_transfer_offer in 080608_1430_balance_transfer_offers.sql
-- inserts only (cashier_id, recipient_id, amount). A NOT NULL column would
-- break that working legacy path on its next call. Same reasoning for
-- money_return_requests, which has insert paths that do not supply it.
-- ---------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- money_assignments
-- --------------------------------------------------------------------------
ALTER TABLE public.money_assignments
  ADD COLUMN IF NOT EXISTS organization_id UUID
  REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Backfill from the cashier's profile, mirroring 20250130000000's approach of
-- resolving org from the paying side of the transaction.
UPDATE public.money_assignments ma
SET organization_id = (
  SELECT p.organization_id
  FROM public.profiles p
  WHERE p.user_id = ma.cashier_id
  LIMIT 1
)
WHERE ma.organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_money_assignments_org
  ON public.money_assignments(organization_id, assigned_at DESC);

COMMENT ON COLUMN public.money_assignments.organization_id IS
  'Nullable by design. Populated by the balance ledger RPCs (DOC-111); the '
  'legacy accept_balance_transfer_offer path in 080608_1430 inserts without '
  'it, so NOT NULL would break that flow.';

-- --------------------------------------------------------------------------
-- money_return_requests
-- --------------------------------------------------------------------------
ALTER TABLE public.money_return_requests
  ADD COLUMN IF NOT EXISTS organization_id UUID
  REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Backfill from the requester's profile -- the requester is the employee whose
-- balance the return draws down, so their org is the transaction's org.
UPDATE public.money_return_requests mrr
SET organization_id = (
  SELECT p.organization_id
  FROM public.profiles p
  WHERE p.user_id = mrr.requester_id
  LIMIT 1
)
WHERE mrr.organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_money_return_requests_org
  ON public.money_return_requests(organization_id, requested_at DESC);

COMMENT ON COLUMN public.money_return_requests.organization_id IS
  'Nullable by design. Read by approve_money_return_request_v2 (DOC-111), '
  'which rejects a request whose organization_id is NULL rather than guessing.';

NOTIFY pgrst, 'reload schema';
