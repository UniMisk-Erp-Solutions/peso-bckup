-- Extend transfer history for payment mode and source bank snapshots

ALTER TABLE public.cash_transfer_history
  ADD COLUMN IF NOT EXISTS payment_mode TEXT,
  ADD COLUMN IF NOT EXISTS source_bank_account_id UUID REFERENCES public.organization_bank_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_bank_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS source_account_holder_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS source_account_number_masked_snapshot TEXT;

-- Backfill old rows as cash mode and enforce default/constraint
UPDATE public.cash_transfer_history
SET payment_mode = 'cash'
WHERE payment_mode IS NULL;

ALTER TABLE public.cash_transfer_history
  ALTER COLUMN payment_mode SET DEFAULT 'cash';

ALTER TABLE public.cash_transfer_history
  ALTER COLUMN payment_mode SET NOT NULL;

ALTER TABLE public.cash_transfer_history
  DROP CONSTRAINT IF EXISTS cash_transfer_history_payment_mode_check;

ALTER TABLE public.cash_transfer_history
  ADD CONSTRAINT cash_transfer_history_payment_mode_check
  CHECK (payment_mode IN ('cash', 'bank_transfer'));

CREATE INDEX IF NOT EXISTS idx_cash_transfer_history_mode
  ON public.cash_transfer_history (organization_id, payment_mode, transferred_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_transfer_history_source_bank
  ON public.cash_transfer_history (source_bank_account_id);

COMMENT ON COLUMN public.cash_transfer_history.payment_mode IS 'Transfer mode: cash or bank_transfer.';
COMMENT ON COLUMN public.cash_transfer_history.source_bank_account_id IS 'Selected organization source bank account when payment_mode is bank_transfer.';
