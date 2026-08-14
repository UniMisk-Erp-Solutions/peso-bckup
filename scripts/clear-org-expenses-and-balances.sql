-- Clear all expenses and balances for one organization.
-- Keeps users (profiles) as-is; only resets balance to 0 and removes all expense-related data.
-- Run in Supabase Dashboard → SQL Editor. Replace the org id below if needed.

DO $$
DECLARE
  target_org_id UUID := 'e0e9c7a9-555f-448a-8ba2-10fae8e0bf64';
  expense_ids UUID[];
BEGIN
  -- Collect all expense ids for this org
  SELECT ARRAY_AGG(id) INTO expense_ids
  FROM public.expenses
  WHERE organization_id = target_org_id;

  IF expense_ids IS NOT NULL AND array_length(expense_ids, 1) > 0 THEN
    -- Delete child rows that reference expenses (order matters for FKs)
    DELETE FROM public.expense_form_field_values WHERE expense_id = ANY(expense_ids);
    DELETE FROM public.attachments WHERE expense_id = ANY(expense_ids);
    DELETE FROM public.audit_logs WHERE expense_id = ANY(expense_ids);
    DELETE FROM public.expense_line_items WHERE expense_id = ANY(expense_ids);
    DELETE FROM public.expenses WHERE organization_id = target_org_id;
  ELSE
    DELETE FROM public.expenses WHERE organization_id = target_org_id;
  END IF;

  -- Clear cash transfer history for this org (balance-related)
  DELETE FROM public.cash_transfer_history WHERE organization_id = target_org_id;

  -- Reset balance to 0 for all users (profiles) in this org; keep all other profile data
  UPDATE public.profiles
  SET balance = 0, updated_at = NOW()
  WHERE organization_id = target_org_id;

  RAISE NOTICE 'Cleared expenses and balances for organization %', target_org_id;
END $$;
