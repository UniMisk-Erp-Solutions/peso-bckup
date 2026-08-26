-- Rollback for 20260820130000_money_return_approve_v2.sql
DROP FUNCTION IF EXISTS public.approve_money_return_request_v2(uuid);
ALTER TABLE public.balance_ledger DROP CONSTRAINT IF EXISTS balance_ledger_source_type_check;
ALTER TABLE public.balance_ledger ADD CONSTRAINT balance_ledger_source_type_check
  CHECK (source_type IN (
    'manual_add',
    'manual_adjust',
    'cashier_transfer',
    'bank_transfer_offer',
    'import_batch',
    'expense_approval',
    'reversal'
  ));
NOTIFY pgrst, 'reload schema';
