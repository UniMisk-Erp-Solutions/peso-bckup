-- ============================================================
-- PesoWise — Clear ALL expenses + balance history for ONE org
-- Organization: 6709c1fe-e8c8-404d-bc68-d1edda923344
--
-- ⚠️  DESTRUCTIVE. Run manually in Supabase → SQL Editor.
--     Does NOT delete users, memberships, categories, or org settings.
--     Receipt files in Storage are NOT removed (see note at bottom).
--
-- Suggested flow:
--   1) Run the PREVIEW block only → check counts + org name
--   2) Uncomment BEGIN…COMMIT and run the DELETE block
--   3) Run POST-CHECK counts
-- ============================================================

-- ── PREVIEW (safe — read only) ───────────────────────────────
WITH target AS (
  SELECT '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid AS organization_id
),
org_users AS (
  SELECT om.user_id
  FROM public.organization_memberships om
  JOIN target t ON t.organization_id = om.organization_id
  WHERE om.is_active = true
)
SELECT
  o.id,
  o.name AS organization_name,
  (SELECT COUNT(*) FROM public.expenses e JOIN target t ON e.organization_id = t.organization_id) AS expenses,
  (SELECT COUNT(*) FROM public.expense_batches b JOIN target t ON b.organization_id = t.organization_id) AS expense_batches,
  (SELECT COUNT(*) FROM public.expense_submission_drafts d JOIN target t ON d.organization_id = t.organization_id) AS submission_drafts,
  (SELECT COUNT(*) FROM public.expense_form_field_values v JOIN target t ON v.organization_id = t.organization_id) AS form_field_values,
  (SELECT COUNT(*) FROM public.expense_correction_logs c JOIN target t ON c.organization_id = t.organization_id) AS correction_logs,
  (SELECT COUNT(*) FROM public.attachments a JOIN target t ON a.organization_id = t.organization_id) AS attachments,
  (SELECT COUNT(*) FROM public.cash_transfer_history h JOIN target t ON h.organization_id = t.organization_id) AS cash_transfers,
  (SELECT COUNT(*) FROM public.balance_transfer_offers bto JOIN target t ON bto.organization_id = t.organization_id) AS transfer_offers,
  (SELECT COUNT(*) FROM public.money_return_requests mrr
     WHERE mrr.requester_id IN (SELECT user_id FROM org_users)
        OR mrr.cashier_id IN (SELECT user_id FROM org_users)) AS money_returns,
  (SELECT COUNT(*) FROM public.money_assignments ma
     WHERE ma.cashier_id IN (SELECT user_id FROM org_users)
        OR ma.recipient_id IN (SELECT user_id FROM org_users)) AS money_assignments,
  (SELECT COUNT(*) FROM public.notifications n
     WHERE n.user_id IN (SELECT user_id FROM org_users)
        OR n.expense_id IN (
          SELECT e.id FROM public.expenses e JOIN target t ON e.organization_id = t.organization_id
        )) AS notifications,
  (SELECT COUNT(*) FROM public.profiles p JOIN target t ON p.organization_id = t.organization_id WHERE COALESCE(p.balance, 0) <> 0) AS profiles_with_nonzero_balance,
  (SELECT COALESCE(SUM(p.balance), 0) FROM public.profiles p JOIN target t ON p.organization_id = t.organization_id) AS total_profile_balance
FROM public.organizations o
JOIN target t ON o.id = t.organization_id;

-- ── DELETE (uncomment entire transaction to execute) ───────────
/*
BEGIN;

DO $$
DECLARE
  v_org uuid := '6709c1fe-e8c8-404d-bc68-d1edda923344';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_org) THEN
    RAISE EXCEPTION 'Organization % not found', v_org;
  END IF;

  -- Notifications tied to org users or org expenses
  DELETE FROM public.notifications n
  WHERE n.user_id IN (
          SELECT om.user_id FROM public.organization_memberships om
          WHERE om.organization_id = v_org AND om.is_active = true
        )
     OR n.expense_id IN (
          SELECT e.id FROM public.expenses e WHERE e.organization_id = v_org
        );

  -- Expense children (explicit; expenses DELETE also cascades many of these)
  DELETE FROM public.expense_form_field_values
  WHERE organization_id = v_org
     OR expense_id IN (SELECT id FROM public.expenses WHERE organization_id = v_org);

  DELETE FROM public.expense_correction_logs
  WHERE organization_id = v_org
     OR expense_id IN (SELECT id FROM public.expenses WHERE organization_id = v_org);

  DELETE FROM public.audit_logs
  WHERE expense_id IN (SELECT id FROM public.expenses WHERE organization_id = v_org);

  DELETE FROM public.attachments
  WHERE organization_id = v_org
     OR expense_id IN (SELECT id FROM public.expenses WHERE organization_id = v_org);

  DELETE FROM public.expense_line_items
  WHERE expense_id IN (SELECT id FROM public.expenses WHERE organization_id = v_org);

  -- Main expense rows
  DELETE FROM public.expenses WHERE organization_id = v_org;

  -- Batch groups + submission safety copies
  DELETE FROM public.expense_batches WHERE organization_id = v_org;
  DELETE FROM public.expense_submission_drafts WHERE organization_id = v_org;

  -- Balance / transfer history for this org
  DELETE FROM public.balance_transfer_offers WHERE organization_id = v_org;
  DELETE FROM public.cash_transfer_history WHERE organization_id = v_org;

  DELETE FROM public.money_return_requests mrr
  WHERE mrr.requester_id IN (
          SELECT om.user_id FROM public.organization_memberships om
          WHERE om.organization_id = v_org AND om.is_active = true
        )
     OR mrr.cashier_id IN (
          SELECT om.user_id FROM public.organization_memberships om
          WHERE om.organization_id = v_org AND om.is_active = true
        );

  DELETE FROM public.money_assignments ma
  WHERE ma.cashier_id IN (
          SELECT om.user_id FROM public.organization_memberships om
          WHERE om.organization_id = v_org AND om.is_active = true
        )
     OR ma.recipient_id IN (
          SELECT om.user_id FROM public.organization_memberships om
          WHERE om.organization_id = v_org AND om.is_active = true
        );

  -- Reset wallet balances for members of this org
  UPDATE public.profiles
  SET balance = 0,
      updated_at = now()
  WHERE organization_id = v_org
    AND COALESCE(balance, 0) <> 0;

  RAISE NOTICE 'Cleared expenses and balances for organization %', v_org;
END $$;

COMMIT;
*/

-- ── POST-CHECK (run after DELETE) ─────────────────────────────
-- Re-run the PREVIEW query above; all counts should be 0 and total_profile_balance 0.

-- ── Storage (optional, manual) ───────────────────────────────
-- SQL does not remove files from the `receipts` bucket. Orphaned objects may remain under:
--   {expense_id}/…  or  temp/{user_id}/…
-- Clear them from Supabase Dashboard → Storage → receipts if you need disk reclaimed.
