-- Per assignment: ask this field once per batch (per category) instead of on every line.

ALTER TABLE public.expense_category_form_fields
  ADD COLUMN IF NOT EXISTS ask_once_per_batch boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.expense_category_form_fields.ask_once_per_batch IS
  'When true, batch expense entry asks this field once for all lines sharing the category; value is stored on each matching expense.';
