-- =============================================================================
-- Clear expense-related data for one organization + create "Trial" org
-- =============================================================================
-- Run this in Supabase Dashboard → SQL Editor as a role that bypasses RLS
-- (e.g. postgres / service role). Review the org UUID before executing.
--
-- What this removes for the target org (auth users & memberships are kept):
--   - Expenses and cascaded rows (line items, attachments, form field values,
--     audit logs, notifications tied to those expenses)
--   - Notifications for that org (including non-expense types)
--   - Money return requests, money assignments, cash transfer history
--   - Category usage tracking
--
-- Receipt files are NOT deleted here: Supabase blocks DELETE on storage.objects
-- (storage.protect_delete). Run FIRST (same org id):
--   node master_migration/clear-org-receipts-storage.mjs e0e9c7a9-555f-448a-8ba2-10fae8e0bf64
--   with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (see that file).
--
-- What stays: organizations row, organization_memberships, profiles,
-- organization_settings, expense categories, locations, form templates, etc.
--
-- After clearing: member balances for that org are reset to 0.
--
-- New org: "Trial" with slug "trial" (ON CONFLICT updates name) + settings row.
-- =============================================================================

DO $$
DECLARE
  target_org UUID := 'e0e9c7a9-555f-448a-8ba2-10fae8e0bf64';
  new_trial_id UUID;
  n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = target_org) THEN
    RAISE EXCEPTION 'Organization not found: %', target_org;
  END IF;

  RAISE NOTICE
    'If you have not run clear-org-receipts-storage.mjs yet, stop and run it first; SQL cannot delete storage.objects on hosted Supabase.';

  -- Org-scoped operational data (order safe for FKs)
  IF to_regclass('public.notifications') IS NOT NULL THEN
    DELETE FROM public.notifications WHERE organization_id = target_org;
  END IF;

  IF to_regclass('public.money_return_requests') IS NOT NULL THEN
    DELETE FROM public.money_return_requests WHERE organization_id = target_org;
  END IF;

  IF to_regclass('public.money_assignments') IS NOT NULL THEN
    DELETE FROM public.money_assignments WHERE organization_id = target_org;
  END IF;

  IF to_regclass('public.cash_transfer_history') IS NOT NULL THEN
    DELETE FROM public.cash_transfer_history WHERE organization_id = target_org;
  END IF;

  IF to_regclass('public.category_usage_tracking') IS NOT NULL THEN
    DELETE FROM public.category_usage_tracking WHERE organization_id = target_org;
  END IF;

  -- Expenses cascade to line items, attachments, audit_logs, form field values,
  -- and notifications that reference expense_id.
  IF to_regclass('public.expenses') IS NOT NULL THEN
    DELETE FROM public.expenses WHERE organization_id = target_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'Deleted % expense(s) for org %', n, target_org;
  END IF;

  -- Reset balances for users who belong to this org (cash tracking only)
  IF to_regclass('public.organization_memberships') IS NOT NULL
     AND to_regclass('public.profiles') IS NOT NULL THEN
    UPDATE public.profiles p
    SET balance = 0,
        updated_at = now()
    WHERE p.user_id IN (
      SELECT om.user_id
      FROM public.organization_memberships om
      WHERE om.organization_id = target_org
    )
    AND COALESCE(p.balance, 0) <> 0;
  END IF;

  -- Create or refresh "Trial" organization (slug must stay URL-safe / unique)
  INSERT INTO public.organizations (
    name,
    slug,
    plan,
    subscription_status,
    payment_status,
    is_active,
    subscription_start_date,
    max_users
  )
  VALUES (
    'Trial',
    'trial',
    'free-trial',
    'active',
    'active',
    true,
    NOW(),
    5
  )
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    plan = EXCLUDED.plan,
    subscription_status = EXCLUDED.subscription_status,
    payment_status = EXCLUDED.payment_status,
    is_active = EXCLUDED.is_active,
    updated_at = now()
  RETURNING id INTO new_trial_id;

  IF new_trial_id IS NULL THEN
    SELECT id INTO new_trial_id FROM public.organizations WHERE slug = 'trial' LIMIT 1;
  END IF;

  INSERT INTO public.organization_settings (
    organization_id,
    engineer_approval_limit,
    attachment_required_above_amount,
    currency,
    timezone
  )
  VALUES (
    new_trial_id,
    50000,
    50,
    'INR',
    'Asia/Kolkata'
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    updated_at = now();

  RAISE NOTICE 'Trial organization id: %', new_trial_id;
  RAISE NOTICE 'Done. Target org % still exists; users and memberships unchanged.', target_org;
END $$;
