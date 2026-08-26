-- DOC-099 — canonical, immutable balance ledger.
--
-- Foundation table for the bulk balance import feature (FUTURE_PLANS.md
-- #16-18) and for fixing the existing manual "Add Amount" / "Edit balance"
-- flows, which the audit (Documentations MD/balance-system-and-import-audit.md)
-- confirmed are today three separate, browser-orchestrated, non-atomic
-- sequences of raw `profiles.update({balance: ...})` calls with a racy or
-- entirely-absent rollback and no server-side pairing/amount-conservation
-- check.
--
-- One row per balance-affecting event, for every source (manual add, manual
-- adjustment, cashier cash transfer, bank transfer, historical import,
-- allocation import, reversal, and — in a later integration phase, see the
-- migration header on the manual RPCs — expense deduction). Written ONLY by
-- SECURITY DEFINER functions in the same transaction as balance itself
-- changes; never by a client INSERT. before/delta/after always reconcile by
-- a hard CHECK constraint, so a row that doesn't add up cannot exist.
--
-- Modeled directly on the proven-correct locking/evidence pattern already in
-- this codebase: supabase/migrations/20260808140000_atomic_expense_approval_balance_deduction.sql
-- (review_approve_expense_v2 / expense_balance_deductions, DOC-089).

CREATE TABLE IF NOT EXISTS public.balance_ledger (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  amount_delta      numeric(14,2) NOT NULL,
  balance_before    numeric(14,2) NOT NULL,
  balance_after     numeric(14,2) NOT NULL,

  entry_type        text        NOT NULL,
  source_type       text        NOT NULL,
  -- Free-form pointer to the originating row (import batch id, transfer
  -- offer id, expense id, or another ledger row's id for a reversal).
  -- Deliberately not a typed FK -- the source table varies by source_type,
  -- and this table must never be blocked from existing by an unrelated
  -- table's lifecycle (e.g. an import batch being retained/archived).
  source_id         uuid,

  actor_user_id     uuid        NOT NULL REFERENCES auth.users(id),
  effective_at      timestamptz NOT NULL DEFAULT now(),
  note              text,
  -- Caller-supplied idempotency key (unique per org when present). Lets a
  -- retried Apply / a double-submitted manual action be detected and
  -- rejected server-side rather than silently double-processed.
  idempotency_key   text,
  -- Set only on a compensating reversal entry; points at the ledger row it
  -- reverses. A reversal is always a NEW row -- nothing is ever edited.
  reversal_of       uuid REFERENCES public.balance_ledger(id),

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT balance_ledger_entry_type_check CHECK (entry_type IN (
    'historical_opening',
    'allocation',
    'manual_adjustment',
    'cash_transfer_in',
    'cash_transfer_out',
    'expense_deduction',
    'reversal',
    'correction'
  )),
  CONSTRAINT balance_ledger_source_type_check CHECK (source_type IN (
    'manual_add',
    'manual_adjust',
    'cashier_transfer',
    'bank_transfer_offer',
    'import_batch',
    'expense_approval',
    'reversal'
  )),
  -- The one constraint that matters most: a ledger row that doesn't
  -- reconcile cannot exist, full stop -- not "should reconcile", enforced.
  CONSTRAINT balance_ledger_reconciles CHECK (balance_after = balance_before + amount_delta)
);

CREATE INDEX IF NOT EXISTS balance_ledger_org_created_idx
  ON public.balance_ledger (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS balance_ledger_user_created_idx
  ON public.balance_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS balance_ledger_source_idx
  ON public.balance_ledger (source_type, source_id);

-- One idempotency key may be used once per organization. NULL keys (most
-- manual single actions won't supply one) are unconstrained -- only import
-- Apply and any caller that explicitly opts in to idempotency protection
-- uses this.
CREATE UNIQUE INDEX IF NOT EXISTS balance_ledger_idempotency_uidx
  ON public.balance_ledger (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON TABLE public.balance_ledger IS
  'DOC-099. Immutable, append-only financial ledger for every balance-affecting '
  'event. Written only by SECURITY DEFINER functions in the same transaction '
  'as the profiles.balance UPDATE it records. before+delta=after is enforced '
  'by a CHECK constraint, not merely convention.';
COMMENT ON COLUMN public.balance_ledger.source_id IS
  'Points at the originating row (import batch, transfer offer, expense, or '
  'another ledger row for a reversal). Not a typed FK -- the referenced table '
  'varies by source_type.';
COMMENT ON COLUMN public.balance_ledger.idempotency_key IS
  'Unique per organization when present. Lets a retried Apply or a '
  'double-submitted action be rejected server-side instead of double-processed.';

-- RLS: immutable. No UPDATE or DELETE policy exists for ANY role, ever --
-- a financial correction is always a new compensating row, never an edit.
ALTER TABLE public.balance_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read org ledger" ON public.balance_ledger;
CREATE POLICY "Admins read org ledger"
  ON public.balance_ledger FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = balance_ledger.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Employees read own ledger" ON public.balance_ledger;
CREATE POLICY "Employees read own ledger"
  ON public.balance_ledger FOR SELECT
  USING (
    balance_ledger.user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = balance_ledger.organization_id
        AND om.is_active = true
    )
  );

-- No INSERT/UPDATE/DELETE policy for any role -- the SECURITY DEFINER
-- functions that write this table run as their owner and bypass RLS
-- entirely, matching the expense_balance_deductions (DOC-089) pattern.
REVOKE ALL ON TABLE public.balance_ledger FROM PUBLIC;
REVOKE ALL ON TABLE public.balance_ledger FROM anon;
GRANT SELECT ON TABLE public.balance_ledger TO authenticated;

NOTIFY pgrst, 'reload schema';
