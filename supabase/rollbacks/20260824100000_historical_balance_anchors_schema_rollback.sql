-- Rollback for 20260824100000_historical_balance_anchors_schema.sql
-- Must run AFTER rolling back 20260824110000/20260824120000/20260824130000
-- (they depend on objects created here).
BEGIN;

ALTER TABLE public.balance_import_rows
  DROP CONSTRAINT IF EXISTS balance_import_rows_validation_status_check;
ALTER TABLE public.balance_import_rows
  ADD CONSTRAINT balance_import_rows_validation_status_check
  CHECK (validation_status IN ('pending', 'valid', 'unknown', 'ambiguous', 'invalid_amount', 'duplicate', 'no_op'));

ALTER TABLE public.balance_import_batches
  DROP CONSTRAINT IF EXISTS balance_import_batches_mode_check;
ALTER TABLE public.balance_import_batches
  ADD CONSTRAINT balance_import_batches_mode_check CHECK (mode IN ('historical_opening', 'allocation'));

ALTER TABLE public.balance_import_rows
  DROP COLUMN IF EXISTS conflict_status,
  DROP COLUMN IF EXISTS conflict_type,
  DROP COLUMN IF EXISTS resolution_action,
  DROP COLUMN IF EXISTS resolution_target_anchor_id,
  DROP COLUMN IF EXISTS resolution_reason,
  DROP COLUMN IF EXISTS resolution_override_balance,
  DROP COLUMN IF EXISTS resolution_override_effective_date,
  DROP COLUMN IF EXISTS resolution_override_note,
  DROP COLUMN IF EXISTS resulting_anchor_id,
  DROP COLUMN IF EXISTS historical_position_before;

-- Restores the constraint to its state immediately BEFORE this migration
-- ran -- i.e. 20260820130000_money_return_approve_v2's version (WITH
-- 'money_return', WITHOUT 'historical_anchor'), not the original
-- pre-20260820130000 list. approve_money_return_request_v2 is untouched by
-- this rollback and still inserts source_type='money_return' after it runs.
ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_source_type_check;
ALTER TABLE public.balance_ledger
  ADD CONSTRAINT balance_ledger_source_type_check CHECK (source_type IN (
    'manual_add', 'manual_adjust', 'cashier_transfer', 'bank_transfer_offer',
    'import_batch', 'expense_approval', 'reversal', 'money_return'
  ));

ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_entry_type_check;
ALTER TABLE public.balance_ledger
  ADD CONSTRAINT balance_ledger_entry_type_check CHECK (entry_type IN (
    'historical_opening', 'allocation', 'manual_adjustment', 'cash_transfer_in',
    'cash_transfer_out', 'expense_deduction', 'reversal', 'correction'
  ));

DROP TABLE IF EXISTS public.balance_historical_anchors;

COMMIT;

NOTIFY pgrst, 'reload schema';
