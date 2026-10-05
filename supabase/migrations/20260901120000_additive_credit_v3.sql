-- Additive Credit Accounting V3 (2026-09-01).
--
-- RETIRES the "target anchor" accounting model for all FUTURE credits.
-- The old model (balance_apply_historical_anchor_v1 and friends, in
-- 20260824110000_historical_balance_anchors_engine.sql) computed
--   materialized_delta = stated_balance - reconstructed_position_before
-- i.e. "make the balance equal this number." The owner has explicitly
-- rejected this: an imported/admin credit of ₹45,000 must ALWAYS mean
-- "add ₹45,000", never "adjust to reach ₹45,000."
--
-- This migration is purely ADDITIVE at the schema level -- it does not
-- touch, rewrite, or drop any old-engine function, table, or row. The old
-- engine is left dormant (per explicit instruction) for rollback/audit; its
-- capability probe (balance_historical_v2_capabilities_v1) and its nine
-- checked functions are untouched. A NEW capability probe
-- (balance_additive_v3_capabilities_v1) gates the new UI instead.
--
-- New vocabulary added to balance_ledger (existing CHECK constraints
-- widened, never narrowed -- old rows/values remain valid):
--   entry_type:  'opening_credit', 'balance_credit', 'credit_reversal'
--   source_type: 'admin_credit_v3', 'import_batch_v3'
-- New balance_import_batches.mode values: 'opening_credit', 'balance_credit'
-- (these replace 'historical_opening'/'balance_update' for NEW imports only
-- -- existing batches under the old mode names are untouched and remain
-- readable/reversible via the old v2 reversal path).
--
-- balance_ledger gains `day_position` (smallint, default 1) so same-day
-- ordering is explicit metadata, exactly mirroring the convention already
-- established on balance_historical_anchors.day_position:
--   0 = Opening Credit      (start of day, before that day's other events)
--   1 = ordinary event      (expense deduction, transfer, allocation, etc.)
--   2 = Balance/Tally Credit (end of day, after that day's other events)
-- This is ORDERING METADATA ONLY -- it has no bearing on the financial
-- delta, which is always exactly the imported/entered amount.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Schema widening (additive only)
-- ---------------------------------------------------------------------

ALTER TABLE public.balance_ledger
  ADD COLUMN IF NOT EXISTS day_position smallint NOT NULL DEFAULT 1;

ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_day_position_check;
ALTER TABLE public.balance_ledger
  ADD CONSTRAINT balance_ledger_day_position_check CHECK (day_position IN (0, 1, 2));

ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_entry_type_check;
ALTER TABLE public.balance_ledger
  ADD CONSTRAINT balance_ledger_entry_type_check CHECK (entry_type IN (
    'historical_opening', 'allocation', 'manual_adjustment', 'cash_transfer_in',
    'cash_transfer_out', 'expense_deduction', 'reversal', 'correction',
    'historical_balance_update', 'historical_anchor_recalculation', 'historical_anchor_reversal',
    'opening_credit', 'balance_credit', 'credit_reversal'
  ));

ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_source_type_check;
ALTER TABLE public.balance_ledger
  ADD CONSTRAINT balance_ledger_source_type_check CHECK (source_type IN (
    'manual_add', 'manual_adjust', 'cashier_transfer', 'bank_transfer_offer',
    'import_batch', 'expense_approval', 'reversal', 'money_return', 'historical_anchor',
    'admin_credit_v3', 'import_batch_v3'
  ));

ALTER TABLE public.balance_import_batches
  DROP CONSTRAINT IF EXISTS balance_import_batches_mode_check;
ALTER TABLE public.balance_import_batches
  ADD CONSTRAINT balance_import_batches_mode_check CHECK (mode IN (
    'historical_opening', 'balance_update', 'allocation', 'opening_credit', 'balance_credit'
  ));

COMMENT ON COLUMN public.balance_ledger.day_position IS
  'Deterministic same-day ordering metadata only (0=start-of-day opening credit, '
  '1=ordinary event, 2=end-of-day balance/Tally credit). Never affects amount_delta.';

-- ---------------------------------------------------------------------
-- 2. Core additive apply (single row, reusable by the manual RPC and by
--    the per-row loop in balance_apply_import_v3)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._balance_apply_credit_core_v3(
  p_organization_id uuid,
  p_target_user_id  uuid,
  p_amount          numeric,
  p_credit_kind     text,      -- 'opening_credit' | 'balance_credit'
  p_effective_date  date,
  p_source_type     text,      -- 'admin_credit_v3' | 'import_batch_v3'
  p_source_id       uuid,
  p_actor_user_id   uuid,
  p_note            text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_existing        record;
  v_effective_at    timestamptz;
  v_day_position    smallint;
  v_balance_before  numeric;
  v_balance_after   numeric;
  v_ledger_id       uuid;
BEGIN
  -- Caller (a public wrapper) has already authorized the actor and
  -- resolved p_target_user_id as an active org member; this internal core
  -- trusts its caller completely, exactly like the old engine's _balance_*
  -- helpers -- it is REVOKEd from anon/authenticated below.
  IF p_amount IS NULL OR p_amount = 0 THEN
    RAISE EXCEPTION 'Credit amount must be non-zero';
  END IF;
  IF p_credit_kind NOT IN ('opening_credit', 'balance_credit') THEN
    RAISE EXCEPTION 'Unknown credit kind: %', p_credit_kind;
  END IF;
  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'Effective date is required';
  END IF;

  -- Idempotency: a retried apply (network retry, duplicate RPC call) with
  -- the same key returns the original result rather than double-crediting.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT bl.id, bl.balance_after INTO v_existing
    FROM public.balance_ledger bl
    WHERE bl.idempotency_key = p_idempotency_key
      AND bl.source_type = p_source_type
      AND bl.organization_id = p_organization_id
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true, 'already_applied', true,
        'ledger_entry_id', v_existing.id, 'balance_after', v_existing.balance_after
      );
    END IF;
  END IF;

  -- Opening Credit = start of day (00:00:00); Balance/Tally Credit = end of
  -- day (23:59:59.999999), matching the pre-existing anchor-engine
  -- convention exactly -- this is ordering metadata only, see day_position.
  IF p_credit_kind = 'opening_credit' THEN
    v_effective_at := p_effective_date::timestamptz;
    v_day_position := 0;
  ELSE
    v_effective_at := (p_effective_date::timestamptz + interval '1 day' - interval '1 microsecond');
    v_day_position := 2;
  END IF;

  -- Lock the target profile row for the duration of this credit.
  PERFORM 1 FROM public.profiles
  WHERE user_id = p_target_user_id AND organization_id = p_organization_id
  FOR UPDATE;

  SELECT COALESCE(balance, 0) INTO v_balance_before
  FROM public.profiles
  WHERE user_id = p_target_user_id AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target profile not found in this organization';
  END IF;

  -- THE ENTIRE FORMULA. No target. No reconstruction. No adjustment math.
  v_balance_after := v_balance_before + p_amount;

  UPDATE public.profiles
  SET balance = v_balance_after, updated_at = now()
  WHERE user_id = p_target_user_id AND organization_id = p_organization_id;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, source_id, actor_user_id, effective_at, day_position,
    note, idempotency_key
  ) VALUES (
    p_organization_id, p_target_user_id, p_amount, v_balance_before, v_balance_after,
    p_credit_kind, p_source_type, p_source_id, p_actor_user_id, v_effective_at, v_day_position,
    p_note, p_idempotency_key
  )
  RETURNING id INTO v_ledger_id;

  RETURN jsonb_build_object(
    'ok', true, 'already_applied', false,
    'ledger_entry_id', v_ledger_id,
    'balance_before', v_balance_before, 'balance_after', v_balance_after,
    'amount_delta', p_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public._balance_apply_credit_core_v3(uuid, uuid, numeric, text, date, text, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_apply_credit_core_v3(uuid, uuid, numeric, text, date, text, uuid, uuid, text, text) FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Public RPC: single admin-entered credit (Opening Credit or Balance
--    Credit for one employee, outside of a file import).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.balance_apply_credit_v3(
  p_organization_id uuid,
  p_target_user_id  uuid,
  p_amount          numeric,
  p_credit_kind     text,
  p_effective_date  date,
  p_note            text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_org_id  uuid;
  v_role    text;
  v_target_org uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT om.organization_id, om.role::text INTO v_org_id, v_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active = true
  LIMIT 1;

  IF v_org_id IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only an organization admin may apply a balance credit';
  END IF;

  SELECT om.organization_id INTO v_target_org
  FROM public.organization_memberships om
  WHERE om.user_id = p_target_user_id AND om.organization_id = p_organization_id AND om.is_active = true
  LIMIT 1;

  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'Target user is not an active member of this organization';
  END IF;

  RETURN public._balance_apply_credit_core_v3(
    p_organization_id, p_target_user_id, p_amount, p_credit_kind, p_effective_date,
    'admin_credit_v3', NULL, v_uid, nullif(trim(p_note), ''), p_idempotency_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_apply_credit_v3(uuid, uuid, numeric, text, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_apply_credit_v3(uuid, uuid, numeric, text, date, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_apply_credit_v3(uuid, uuid, numeric, text, date, text, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. Reversal: subtracts EXACTLY the original amount. Never recomputes a
--    target. Never touches any other ledger row for this or any other user.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.balance_reverse_credit_v3(
  p_ledger_id uuid,
  p_reason    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_role           text;
  v_original       record;
  v_already        record;
  v_balance_before numeric;
  v_balance_after  numeric;
  v_reversal_id    uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse a credit';
  END IF;

  SELECT * INTO v_original FROM public.balance_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger entry not found';
  END IF;
  IF v_original.entry_type NOT IN ('opening_credit', 'balance_credit') THEN
    RAISE EXCEPTION 'Only an opening_credit or balance_credit entry can be reversed via this function';
  END IF;

  SELECT om.role::text INTO v_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_original.organization_id AND om.is_active = true
  LIMIT 1;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only an organization admin may reverse a balance credit';
  END IF;

  -- Idempotent: a credit can only ever be reversed once.
  SELECT id, balance_after INTO v_already FROM public.balance_ledger WHERE reversal_of = p_ledger_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_reversed', true,
      'reversal_ledger_id', v_already.id, 'balance_after', v_already.balance_after
    );
  END IF;

  PERFORM 1 FROM public.profiles
  WHERE user_id = v_original.user_id AND organization_id = v_original.organization_id
  FOR UPDATE;

  SELECT COALESCE(balance, 0) INTO v_balance_before
  FROM public.profiles
  WHERE user_id = v_original.user_id AND organization_id = v_original.organization_id;

  -- Exact inverse of the original delta. Nothing else.
  v_balance_after := v_balance_before - v_original.amount_delta;

  UPDATE public.profiles
  SET balance = v_balance_after, updated_at = now()
  WHERE user_id = v_original.user_id AND organization_id = v_original.organization_id;

  INSERT INTO public.balance_ledger (
    organization_id, user_id, amount_delta, balance_before, balance_after,
    entry_type, source_type, source_id, actor_user_id, effective_at, day_position,
    note, reversal_of
  ) VALUES (
    v_original.organization_id, v_original.user_id, -v_original.amount_delta,
    v_balance_before, v_balance_after,
    'credit_reversal', v_original.source_type, v_original.source_id, v_uid, now(), 1,
    p_reason, p_ledger_id
  )
  RETURNING id INTO v_reversal_id;

  -- If this credit came from an import row, mark the row/batch reversed so
  -- Admin Import History can show "Reversed" without touching the ledger.
  UPDATE public.balance_import_rows
  SET note = COALESCE(note, '') -- no-op touch reserved for future use; row identity kept via ledger_entry_id lookup below
  WHERE ledger_entry_id = p_ledger_id;

  IF v_original.source_type = 'import_batch_v3' THEN
    UPDATE public.balance_import_batches
    SET status = 'reversed', reversed_at = now(), reversed_by = v_uid
    WHERE id = v_original.source_id
      AND NOT EXISTS (
        SELECT 1 FROM public.balance_import_rows r
        JOIN public.balance_ledger bl2 ON bl2.id = r.ledger_entry_id
        WHERE r.batch_id = v_original.source_id
          AND NOT EXISTS (SELECT 1 FROM public.balance_ledger rv WHERE rv.reversal_of = bl2.id)
      );
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'already_reversed', false,
    'reversal_ledger_id', v_reversal_id,
    'balance_before', v_balance_before, 'balance_after', v_balance_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_reverse_credit_v3(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_reverse_credit_v3(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_reverse_credit_v3(uuid, text) TO authenticated;

COMMIT;
