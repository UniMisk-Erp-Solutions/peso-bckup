-- ============================================================================
-- MIGRATION: Reset Organization Financial Data
-- ============================================================================
-- This script resets all financial data for a specific organization:
-- - Deletes all expenses (and related data: line items, attachments, audit logs)
-- - Resets all user balances to 0
-- - Deletes all money assignments
-- - Deletes all money return requests
-- - Deletes all notifications
-- - Resets transaction number sequences
--
-- KEEPS INTACT:
-- - Users and organization structure
-- - Organization memberships
-- - Locations
-- - Expense categories
-- - Organization settings
-- ============================================================================

-- SET THE ORGANIZATION ID HERE
DO $$
DECLARE
  target_org_id UUID := '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';
  deleted_count INTEGER;
BEGIN
  -- Verify organization exists
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = target_org_id) THEN
    RAISE EXCEPTION USING MESSAGE = format('Organization %s does not exist', target_org_id);
  END IF;

  RAISE NOTICE USING MESSAGE = format('Starting data reset for organization: %s', target_org_id);

  -- ============================================================================
  -- PART 1: DELETE NOTIFICATIONS
  -- ============================================================================
  DELETE FROM public.notifications 
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Deleted %s notification(s)', deleted_count);

  -- ============================================================================
  -- PART 2: DELETE MONEY RETURN REQUESTS
  -- ============================================================================
  DELETE FROM public.money_return_requests 
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Deleted %s money return request(s)', deleted_count);

  -- ============================================================================
  -- PART 3: DELETE MONEY ASSIGNMENTS
  -- ============================================================================
  DELETE FROM public.money_assignments 
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Deleted %s money assignment(s)', deleted_count);

  -- ============================================================================
  -- PART 4: DELETE EXPENSES (this will cascade to line items, attachments, audit logs)
  -- ============================================================================
  -- First, delete attachments (they reference expenses)
  DELETE FROM public.attachments 
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Deleted %s attachment(s)', deleted_count);

  -- Delete audit logs
  DELETE FROM public.audit_logs 
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Deleted %s audit log(s)', deleted_count);

  -- Delete expense line items
  DELETE FROM public.expense_line_items 
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Deleted %s expense line item(s)', deleted_count);

  -- Delete expenses
  DELETE FROM public.expenses 
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Deleted %s expense(s)', deleted_count);

  -- ============================================================================
  -- PART 5: RESET USER BALANCES
  -- ============================================================================
  UPDATE public.profiles 
  SET balance = 0,
      updated_at = now()
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Reset balances for %s profile(s)', deleted_count);

  -- ============================================================================
  -- PART 6: RESET TRANSACTION NUMBER SEQUENCE
  -- ============================================================================
  DELETE FROM public.organization_transaction_sequences 
  WHERE organization_id = target_org_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE USING MESSAGE = format('Reset transaction number sequence (%s row(s) deleted)', deleted_count);

  -- ============================================================================
  -- PART 7: CLEAN UP STORAGE (receipts/bills)
  -- ============================================================================
  -- Note: This requires Supabase Storage API access
  -- You may need to manually delete files from the storage bucket
  -- The files are stored in: receipts/{expense_id}/
  -- Since we've deleted all expenses, the references are gone, but files remain
  RAISE NOTICE 'Note: Storage files need to be manually cleaned up from Supabase Storage bucket "receipts"';

  RAISE NOTICE USING MESSAGE = format('Data reset completed successfully for organization: %s', target_org_id);
END $$;

-- ============================================================================
-- VERIFICATION QUERIES (Run these separately to verify)
-- ============================================================================

-- Check remaining expenses
-- SELECT COUNT(*) as remaining_expenses FROM public.expenses WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';

-- Check remaining balances
-- SELECT user_id, name, balance FROM public.profiles WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';

-- Check remaining money assignments
-- SELECT COUNT(*) as remaining_assignments FROM public.money_assignments WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';

-- Check remaining notifications
-- SELECT COUNT(*) as remaining_notifications FROM public.notifications WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

