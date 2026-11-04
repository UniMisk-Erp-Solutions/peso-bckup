-- DOC-148 (part 2) -- SERVER-SIDE LOGICAL SUBMISSION IDENTITY.
--
-- Closes the last stranded-draft gap: after the first part of the fix, a draft that the browser
-- created could still be orphaned and duplicated if the browser lost ALL local state (tab closed,
-- storage cleared) before the retry, because only the browser remembered which row belonged to the
-- submission. Identity now lives in the database:
--
--   one logical submission  =  (organization_id, user_id, client_submission_id)  =  ONE expense row
--
-- enforced by a partial UNIQUE index, so two concurrent "new expense" requests with the same id can
-- never produce two rows. Batch parents get the same guarantee through client_batch_id, and every
-- batch line derives a stable per-line id from (client_batch_id, line_index), so retrying line 6
-- after a restart resolves to the same row.
--
-- What this migration does NOT do: it does not move approval routing (that stays in the client's
-- submit step), does not touch RLS policies, does not touch the MicroLink atomic RPCs, and does
-- not backfill any existing row (legacy rows have NULL ids and keep working by expense id).

BEGIN;

-- ─── 1. identity columns + uniqueness ────────────────────────────────────────
ALTER TABLE public.expenses        ADD COLUMN IF NOT EXISTS client_submission_id uuid;
ALTER TABLE public.expense_batches ADD COLUMN IF NOT EXISTS client_batch_id      uuid;

CREATE UNIQUE INDEX IF NOT EXISTS expenses_client_submission_uidx
  ON public.expenses (organization_id, user_id, client_submission_id)
  WHERE client_submission_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS expense_batches_client_batch_uidx
  ON public.expense_batches (organization_id, user_id, client_batch_id)
  WHERE client_batch_id IS NOT NULL;

COMMENT ON COLUMN public.expenses.client_submission_id IS
  'Client-generated id of ONE logical expense submission. Unique per (organization, user). NULL for legacy rows. DOC-148.';
COMMENT ON COLUMN public.expense_batches.client_batch_id IS
  'Client-generated id of ONE logical batch submission. Unique per (organization, user). NULL for legacy rows. DOC-148.';

-- ─── 2. resolve-or-create one expense ────────────────────────────────────────
-- Exactly one of:
--   p_client_submission_id                      single expense
--   p_client_batch_id + p_line_index            a batch line (id derived: md5(batch || ':' || index)::uuid)
-- Returns {expense_id, status, created, idempotent_replay, in_recycle_bin, client_submission_id,
--          transaction_number}.
CREATE OR REPLACE FUNCTION public.resolve_or_create_expense_v1(
  p_organization_id      uuid,
  p_client_submission_id uuid,
  p_fields               jsonb,
  p_client_batch_id      uuid DEFAULT NULL,
  p_line_index           integer DEFAULT NULL,
  p_batch_id             uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_csid    uuid;
  e         public.expenses%ROWTYPE;
  v_new_id  uuid;
  v_created boolean := false;
  k         text;
  v_allowed constant text[] := ARRAY['title','destination','trip_start','trip_end','purpose','category','total_amount'];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;

  -- identity: exactly one mode
  IF p_client_batch_id IS NOT NULL THEN
    IF p_line_index IS NULL OR p_line_index < 0 OR p_client_submission_id IS NOT NULL THEN
      RAISE EXCEPTION 'batch lines need client_batch_id + line_index and no client_submission_id' USING ERRCODE = '22023';
    END IF;
    v_csid := md5(p_client_batch_id::text || ':' || p_line_index::text)::uuid;
  ELSE
    IF p_client_submission_id IS NULL OR p_line_index IS NOT NULL THEN
      RAISE EXCEPTION 'client_submission_id is required' USING ERRCODE = '22023';
    END IF;
    v_csid := p_client_submission_id;
  END IF;

  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'p_fields must be a json object' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (k = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'Field "%" cannot be set here', k USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Same authorization the INSERT policy applies to a normal client insert.
  IF NOT EXISTS (
       SELECT 1 FROM public.organization_memberships om
       WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active
         AND (om.role IN ('employee','engineer','admin','team_leader','executive')
              OR (om.role = 'cashier' AND EXISTS (
                    SELECT 1 FROM public.organization_settings os
                    WHERE os.organization_id = p_organization_id AND os.allow_cashier_expense_submission)))
     )
     OR public.is_accountant_cashier(v_uid, p_organization_id) THEN
    RAISE EXCEPTION 'You are not allowed to create expenses in this organization' USING ERRCODE = '42501';
  END IF;

  -- 1) already known? (only ever the caller's own row in the caller's org)
  SELECT * INTO e FROM public.expenses
  WHERE organization_id = p_organization_id AND user_id = v_uid AND client_submission_id = v_csid;

  IF NOT FOUND THEN
    -- 2) create exactly one; a concurrent request with the same id loses ON CONFLICT and resolves below
    INSERT INTO public.expenses (
      user_id, organization_id, client_submission_id, title, destination, trip_start, trip_end,
      purpose, category, total_amount, status
    )
    VALUES (
      v_uid, p_organization_id, v_csid,
      p_fields->>'title', p_fields->>'destination',
      (p_fields->>'trip_start')::date, (p_fields->>'trip_end')::date,
      p_fields->>'purpose', p_fields->>'category',
      COALESCE((p_fields->>'total_amount')::numeric, 0), 'draft'
    )
    ON CONFLICT (organization_id, user_id, client_submission_id) WHERE client_submission_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL THEN
      v_created := true;
      INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
      VALUES (v_new_id, v_uid, p_organization_id, 'expense_created', 'Expense created');
    END IF;

    SELECT * INTO e FROM public.expenses
    WHERE organization_id = p_organization_id AND user_id = v_uid AND client_submission_id = v_csid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not resolve the expense for this submission' USING ERRCODE = 'XX000';
    END IF;
  ELSIF e.deleted_at IS NULL AND e.status = 'draft' THEN
    -- replay of a live draft: refresh it with the current form values (same id)
    PERFORM public.update_own_draft_expense_v1(e.id, p_fields);
    SELECT * INTO e FROM public.expenses WHERE id = e.id;
  END IF;

  -- optional batch link (draft only; idempotent)
  IF p_batch_id IS NOT NULL AND e.deleted_at IS NULL AND e.status = 'draft' THEN
    PERFORM public.link_expense_to_batch_v1(e.id, p_batch_id);
  END IF;

  RETURN jsonb_build_object(
    'expense_id', e.id,
    'status', e.status,
    'created', v_created,
    'idempotent_replay', NOT v_created,
    'in_recycle_bin', e.deleted_at IS NOT NULL,
    'client_submission_id', v_csid,
    'transaction_number', e.transaction_number
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_or_create_expense_v1(uuid, uuid, jsonb, uuid, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_or_create_expense_v1(uuid, uuid, jsonb, uuid, integer, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_or_create_expense_v1(uuid, uuid, jsonb, uuid, integer, uuid) TO authenticated;

-- ─── 3. resolve-or-create one batch parent ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_or_create_expense_batch_v1(
  p_organization_id     uuid,
  p_client_batch_id     uuid,
  p_label               text,
  p_shared_category     text,
  p_shared_expense_date date,
  p_total_amount        numeric
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  b     public.expense_batches%ROWTYPE;
  v_new uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL OR p_client_batch_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active
  ) THEN
    RAISE EXCEPTION 'You are not an active member of this organization' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.expense_batches (organization_id, user_id, client_batch_id, label, shared_category, shared_expense_date, line_count, total_amount)
  VALUES (p_organization_id, v_uid, p_client_batch_id, p_label, p_shared_category, p_shared_expense_date, 0, COALESCE(p_total_amount, 0))
  ON CONFLICT (organization_id, user_id, client_batch_id) WHERE client_batch_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_new;

  SELECT * INTO b FROM public.expense_batches
  WHERE organization_id = p_organization_id AND user_id = v_uid AND client_batch_id = p_client_batch_id;

  RETURN jsonb_build_object('batch_id', b.id, 'created', v_new IS NOT NULL, 'idempotent_replay', v_new IS NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_or_create_expense_batch_v1(uuid, uuid, text, text, date, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_or_create_expense_batch_v1(uuid, uuid, text, text, date, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_or_create_expense_batch_v1(uuid, uuid, text, text, date, numeric) TO authenticated;

-- ─── 4. give a LEGACY draft an identity, only when the owner continues it ───
-- Never infers identity from similarity; never overwrites an existing id; idempotent.
CREATE OR REPLACE FUNCTION public.claim_client_submission_id_v1(p_expense_id uuid, p_client_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e     public.expenses%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_client_submission_id IS NULL THEN
    RAISE EXCEPTION 'client_submission_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND OR e.user_id <> v_uid THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = '42704';
  END IF;

  IF e.client_submission_id IS NOT NULL THEN
    RETURN jsonb_build_object('expense_id', e.id, 'client_submission_id', e.client_submission_id, 'assigned', false);
  END IF;

  IF EXISTS (SELECT 1 FROM public.expenses x
             WHERE x.organization_id = e.organization_id AND x.user_id = v_uid AND x.client_submission_id = p_client_submission_id) THEN
    RAISE EXCEPTION 'That submission id already belongs to another expense' USING ERRCODE = '23505';
  END IF;

  UPDATE public.expenses SET client_submission_id = p_client_submission_id WHERE id = e.id;
  RETURN jsonb_build_object('expense_id', e.id, 'client_submission_id', p_client_submission_id, 'assigned', true);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_client_submission_id_v1(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_client_submission_id_v1(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_client_submission_id_v1(uuid, uuid) TO authenticated;

DO $verify$
BEGIN
  IF to_regprocedure('public.resolve_or_create_expense_v1(uuid, uuid, jsonb, uuid, integer, uuid)') IS NULL
     OR to_regprocedure('public.resolve_or_create_expense_batch_v1(uuid, uuid, text, text, date, numeric)') IS NULL
     OR to_regprocedure('public.claim_client_submission_id_v1(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'submission identity RPCs missing';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_or_create_expense_v1(uuid, uuid, jsonb, uuid, integer, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.resolve_or_create_expense_batch_v1(uuid, uuid, text, text, date, numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.claim_client_submission_id_v1(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute the submission identity RPCs';
  END IF;
END
$verify$;

COMMIT;
