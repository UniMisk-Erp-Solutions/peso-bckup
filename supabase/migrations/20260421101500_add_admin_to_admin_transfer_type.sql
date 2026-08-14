-- Allow admin-to-admin transfers in cash transfer history

ALTER TABLE public.cash_transfer_history
DROP CONSTRAINT IF EXISTS cash_transfer_history_transfer_type_check;

ALTER TABLE public.cash_transfer_history
ADD CONSTRAINT cash_transfer_history_transfer_type_check
CHECK (transfer_type IN (
  'admin_to_cashier',
  'admin_to_employee',
  'admin_to_engineer',
  'admin_to_admin',
  'cashier_to_employee',
  'cashier_to_engineer',
  'cashier_to_admin',
  'employee_to_cashier',
  'engineer_to_cashier'
));

COMMENT ON COLUMN public.cash_transfer_history.transfer_type IS
  'Type of transfer: admin_to_cashier, admin_to_employee, admin_to_engineer, admin_to_admin, cashier_to_employee, cashier_to_engineer, cashier_to_admin, employee_to_cashier, engineer_to_cashier';
