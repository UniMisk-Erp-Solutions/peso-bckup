-- Renamed 2026-08-24 from 20260820160000 during the main-merge reconciliation:
-- that timestamp collided with main's 20260820160000_daily_project_report_server_pagination.sql
-- (different filename, same version prefix). Neither filename is recorded in
-- supabase_migrations.schema_migrations on Production -- both objects were
-- applied via direct SSH psql exec -- so this rename has no live-database
-- effect. Original content below is unchanged.
-- DOC-099 — financial path closure pass, corrective migration #7.
-- Found during an independent re-scan of the full origin/main...HEAD diff
-- (not caught by any prior grep-by-service-file pass): Expenses.tsx's
-- "cashier returns money to admin" flow (no approval needed, immediate) is
-- STILL fully client-orchestrated -- reads the admin's balance, computes
-- both new balances in the browser, issues two independent unlocked
-- `.update({balance: ...})` PATCHes with no rollback if the second one
-- fails after the first succeeds, and writes cash_transfer_history as a
-- best-effort afterthought. The exact same defect class every other RPC in
-- this migration set was built to eliminate.
--
-- An existing RPC, cashier_return_money_to_admin(cashier_user_id,
-- admin_user_id, amount_param), already exists (290529_1700) and is never
-- called by the frontend at all -- but it takes the caller's own user_id as
-- a trusted PARAMETER (anti-pattern: must derive from auth.uid()), has no
-- FOR UPDATE locking (same lost-update race as the old
-- accept_balance_transfer_offer), and never writes balance_ledger. It
-- predates this session's DDL role (same batch as the other legacy
-- functions) and cannot be CREATE OR REPLACEd here for the same ownership
-- reason already documented for propose/accept_balance_transfer_offer.
--
-- New function instead: cashier_return_money_to_admin_v2. Caller resolved
-- from auth.uid(). Locks both profile rows FOR UPDATE in deterministic
-- ascending-user_id order, re-reads balances only after locking, debits
-- cashier / credits admin, writes balance_ledger evidence for both sides
-- (source_type='cashier_transfer', already a valid value in
-- balance_ledger_source_type_check and unused until now), and
-- cash_transfer_history, all in one transaction.

CREATE OR REPLACE FUNCTION public.cashier_return_money_to_admin_v2(
  p_admin_user_id uuid,
  p_amount        numeric,
  p_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid                  uuid := auth.uid();
  v_org_id                uuid;
  v_note                  text := nullif(trim(p_note), '');
  v_lock_first            uuid;
  v_lock_second           uuid;
  v_cashier_balance_before numeric;
  v_cashier_balance_after  numeric;
  v_admin_balance_before   numeric;
  v_admin_balance_after    numeric;
  v_admin_name             text;
  v_cashier_ledger_id      uuid;
  v_admin_ledger_id        uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive number';
  END IF;

  IF p_admin_user_id = v_uid THEN
    RAISE EXCEPTION 'Cannot return money to yourself';
  END IF;

  SELECT om.organization_id INTO v_org_id
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.role = 'cashier' AND om.is_active = true
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'You are not an active cashier in any organization';
  END IF;

  IF public.is_accountant_cashier(v_uid, v_org_id) THEN
    RAISE EXCEPTION 'Accountant cashiers have read-only access';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = p_admin_user_id AND om.organization_id = v_org_id
      AND om.role = 'admin' AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Target user is not an active admin in your organization';
  END IF;

  IF v_uid < p_admin_user_id THEN
    v_lock_first := v_uid; v_lock_second := p_admin_user_id;
  ELSE
    v_lock_first := p_admin_user_id; v_lock_second := v_uid;
  END IF;
  PERFORM 1 FROM public.profiles WHERE user_id = v_lock_first FOR UPDATE;
  PERFORM 1 FROM public.profiles WHERE user_id = v_lock_second FOR UPDATE;

  SELECT COALESCE(balance, 0) INTO v_cashier_balance_before
  FROM public.profiles WHERE user_id = v_uid;

  IF v_cashier_balance_before < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance: you have %, tried to return %', v_cashier_balance_before, p_amount;
  END IF;

  UPDATE public.profiles
  SET balance = COALESCE(balance, 0) - p_amount, updated_at = now()
  WHERE user_id = v_uid
  RETURNING balance INTO v_cashier_balance_after;

  SELECT COALESCE(balance, 0) INTO v_admin_balance_before
  FROM public.profiles WHERE user_id = p_admin_user_id;

  UPDATE public.profiles
  SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_admin_user_id
  RETURNING balance, name INTO v_admin_balance_after, v_admin_name;

  IF v_admin_balance_after IS NULL THEN
    RAISE EXCEPTION 'Balance update affected no row; return rolled back (admin)';
  END IF;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, actor_user_id, note
  ) VALUES (
    v_org_id, v_uid, -p_amount, v_cashier_balance_before, v_cashier_balance_after,
    'cash_transfer_out', 'cashier_transfer', v_uid, v_note
  ) RETURNING id INTO v_cashier_ledger_id;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, source_id, actor_user_id, note
  ) VALUES (
    v_org_id, p_admin_user_id, p_amount, v_admin_balance_before, v_admin_balance_after,
    'cash_transfer_in', 'cashier_transfer', v_cashier_ledger_id, v_uid, v_note
  ) RETURNING id INTO v_admin_ledger_id;

  INSERT INTO public.cash_transfer_history (
    organization_id, transferrer_id, transferrer_role, recipient_id, recipient_role,
    amount, transfer_type, transferred_at, payment_mode, notes
  ) VALUES (
    v_org_id, v_uid, 'cashier', p_admin_user_id, 'admin',
    p_amount, 'cashier_to_admin', now(), 'cash',
    COALESCE(v_note, 'Cashier returned money to admin')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'admin_user_id', p_admin_user_id,
    'admin_name', v_admin_name,
    'amount', p_amount,
    'cashier_balance_after', v_cashier_balance_after,
    'admin_balance_after', v_admin_balance_after,
    'ledger_entry_id', v_admin_ledger_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cashier_return_money_to_admin_v2(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cashier_return_money_to_admin_v2(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cashier_return_money_to_admin_v2(uuid, numeric, text) TO authenticated;

COMMENT ON FUNCTION public.cashier_return_money_to_admin_v2(uuid, numeric, text) IS
  'DOC-099. Replaces Expenses.tsx''s browser-orchestrated double-PATCH '
  '"cashier return money to admin" flow. Caller-derived from auth.uid(), '
  'locks both profile rows FOR UPDATE in deterministic order, writes '
  'balance_ledger evidence (source_type=cashier_transfer) for both sides and '
  'cash_transfer_history, all in one transaction. The older '
  'cashier_return_money_to_admin (290529_1700) predates this session''s DDL '
  'role and could not be replaced in place; it was never called by any '
  'frontend code and remains unused.';

NOTIFY pgrst, 'reload schema';
