-- DOC-148 -- Stranded draft / re-submit fix (server part).
--
-- Production audit (2026-10-16) proved three server-side contributors:
--   (1) 20260922090000 section 3 narrowed the owner UPDATE policy so a row can no
--       longer stay `draft` while any column changes. Two legacy client calls need exactly
--       that: linking a freshly created batch line to its batch (batch_id), and editing a
--       saved/withdrawn draft. The first fails silently (no batch child has been attached
--       since 2026-09-22); the second makes a stranded draft impossible to rescue.
--   (2) The legacy client creates a draft row BEFORE the server's required-field validator
--       runs, so a rejected submit leaves an orphan draft.
--
-- This migration adds three narrow SECURITY DEFINER RPCs. It does NOT touch any RLS policy,
-- table, trigger, or existing function, and moves no data.
--
--   update_own_draft_expense_v1   owner edits a DRAFT; 7 whitelisted columns only; stays draft
--   link_expense_to_batch_v1      owner attaches own DRAFT to own batch (same org); never re-links
--   preflight_expense_submission_v1
--                                 asks the server's OWN validator (expense_submission_integrity_issues_v1)
--                                 whether these field values would be accepted, BEFORE any row is
--                                 created. It builds a throwaway row inside a sub-transaction and
--                                 rolls it back, so nothing is ever persisted and there is no
--                                 second copy of the rules to drift.

BEGIN;

-- ─── 1. owner edits a draft ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_own_draft_expense_v1(p_expense_id uuid, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  e         public.expenses%ROWTYPE;
  k         text;
  v_allowed constant text[] := ARRAY['title','destination','trip_start','trip_end','purpose','category','total_amount'];
  r         public.expenses%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'p_fields must be a json object' USING ERRCODE = '22023';
  END IF;

  -- Fail closed on anything outside the whitelist (status, user_id, organization_id,
  -- batch_id, approval/assignment columns, transaction_number, balances ...).
  FOR k IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (k = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'Field "%" cannot be changed on a draft expense', k USING ERRCODE = '42501';
    END IF;
  END LOOP;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = '42704';
  END IF;
  IF e.user_id <> v_uid THEN
    RAISE EXCEPTION 'You don''t have permission to edit this expense' USING ERRCODE = '42501';
  END IF;
  IF e.organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = e.organization_id AND om.is_active
  ) THEN
    RAISE EXCEPTION 'You are not an active member of this expense''s organization' USING ERRCODE = '42501';
  END IF;
  IF e.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This expense is in the Recycle Bin; restore it first' USING ERRCODE = '55000';
  END IF;
  IF e.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft expense can be edited this way (current status: %)', e.status USING ERRCODE = '55000';
  END IF;

  UPDATE public.expenses x SET
    title        = CASE WHEN p_fields ? 'title'        THEN p_fields->>'title'                    ELSE x.title END,
    destination  = CASE WHEN p_fields ? 'destination'  THEN p_fields->>'destination'              ELSE x.destination END,
    trip_start   = CASE WHEN p_fields ? 'trip_start'   THEN (p_fields->>'trip_start')::date       ELSE x.trip_start END,
    trip_end     = CASE WHEN p_fields ? 'trip_end'     THEN (p_fields->>'trip_end')::date         ELSE x.trip_end END,
    purpose      = CASE WHEN p_fields ? 'purpose'      THEN p_fields->>'purpose'                  ELSE x.purpose END,
    category     = CASE WHEN p_fields ? 'category'     THEN p_fields->>'category'                 ELSE x.category END,
    total_amount = CASE WHEN p_fields ? 'total_amount' THEN (p_fields->>'total_amount')::numeric  ELSE x.total_amount END,
    updated_at   = now()
  WHERE x.id = p_expense_id
  RETURNING * INTO r;

  RETURN to_jsonb(r);
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_draft_expense_v1(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_own_draft_expense_v1(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_own_draft_expense_v1(uuid, jsonb) TO authenticated;

-- ─── 2. attach a draft line to a batch ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.link_expense_to_batch_v1(p_expense_id uuid, p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e     public.expenses%ROWTYPE;
  b     public.expense_batches%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = '42704';
  END IF;
  SELECT * INTO b FROM public.expense_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found' USING ERRCODE = '42704';
  END IF;

  IF e.user_id <> v_uid OR b.user_id <> v_uid THEN
    RAISE EXCEPTION 'You don''t have permission to link this expense to this batch' USING ERRCODE = '42501';
  END IF;
  IF e.organization_id IS DISTINCT FROM b.organization_id OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = e.organization_id AND om.is_active
  ) THEN
    RAISE EXCEPTION 'Expense and batch must belong to the same organization you are an active member of' USING ERRCODE = '42501';
  END IF;
  IF e.deleted_at IS NOT NULL OR e.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a live draft expense can be linked to a batch (current status: %)', e.status USING ERRCODE = '55000';
  END IF;
  IF e.batch_id IS NOT NULL AND e.batch_id <> p_batch_id THEN
    RAISE EXCEPTION 'This expense already belongs to a different batch' USING ERRCODE = '55000';
  END IF;

  -- Idempotent: re-linking to the same batch is a no-op success.
  UPDATE public.expenses SET batch_id = p_batch_id, updated_at = now() WHERE id = p_expense_id AND batch_id IS DISTINCT FROM p_batch_id;

  RETURN jsonb_build_object('ok', true, 'expense_id', p_expense_id, 'batch_id', p_batch_id);
END;
$$;

REVOKE ALL ON FUNCTION public.link_expense_to_batch_v1(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_expense_to_batch_v1(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.link_expense_to_batch_v1(uuid, uuid) TO authenticated;

-- ─── 3. required-field preflight (nothing is persisted) ───────────────────────
-- p_values: [{"template_id": uuid|null, "branch_field_id": uuid|null, "value": text}, ...]
-- Returns {"ok": bool, "issues": [{"label","source","code","severity"}...]}.
CREATE OR REPLACE FUNCTION public.preflight_expense_submission_v1(
  p_organization_id uuid, p_category text, p_values jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_id     uuid := gen_random_uuid();
  v_detail text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active
  ) THEN
    RAISE EXCEPTION 'You are not an active member of this organization' USING ERRCODE = '42501';
  END IF;
  IF p_values IS NOT NULL AND jsonb_typeof(p_values) <> 'array' THEN
    RAISE EXCEPTION 'p_values must be a json array' USING ERRCODE = '22023';
  END IF;

  -- Everything inside this block is rolled back by the RAISE below: the throwaway draft,
  -- its field values and any trigger side effects never leave this call.
  BEGIN
    INSERT INTO public.expenses (id, user_id, organization_id, title, destination, trip_start, trip_end, category, total_amount, status)
    VALUES (v_id, v_uid, p_organization_id, 'preflight', '-', current_date, current_date, NULLIF(p_category, ''), 0, 'draft');

    INSERT INTO public.expense_form_field_values (organization_id, expense_id, template_id, branch_field_id, field_value)
    SELECT p_organization_id, v_id,
           NULLIF(x->>'template_id', '')::uuid,
           NULLIF(x->>'branch_field_id', '')::uuid,
           COALESCE(x->>'value', '')
    FROM jsonb_array_elements(COALESCE(p_values, '[]'::jsonb)) AS x;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'label', i.field_label, 'source', i.issue_source, 'code', i.issue_code, 'severity', i.severity
           ) ORDER BY i.sort_order), '[]'::jsonb)::text
      INTO v_detail
    FROM public.expense_submission_integrity_issues_v1(v_id) i;

    RAISE EXCEPTION 'preflight_rollback' USING ERRCODE = 'PF001', DETAIL = v_detail;
  EXCEPTION WHEN SQLSTATE 'PF001' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;

  RETURN jsonb_build_object('ok', v_detail = '[]', 'issues', v_detail::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.preflight_expense_submission_v1(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preflight_expense_submission_v1(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.preflight_expense_submission_v1(uuid, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.update_own_draft_expense_v1(uuid, jsonb) IS
  'Owner edits own DRAFT (title,destination,trip_start,trip_end,purpose,category,total_amount only); status never changes. DOC-148.';
COMMENT ON FUNCTION public.link_expense_to_batch_v1(uuid, uuid) IS
  'Owner links own live DRAFT to own batch in the same org; idempotent; never moves a row between batches. DOC-148.';
COMMENT ON FUNCTION public.preflight_expense_submission_v1(uuid, text, jsonb) IS
  'Runs the server required-field validator against a rolled-back throwaway row. Persists nothing. DOC-148.';

DO $verify$
BEGIN
  IF to_regprocedure('public.update_own_draft_expense_v1(uuid, jsonb)') IS NULL
     OR to_regprocedure('public.link_expense_to_batch_v1(uuid, uuid)') IS NULL
     OR to_regprocedure('public.preflight_expense_submission_v1(uuid, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'stranded-draft RPCs missing';
  END IF;
  IF has_function_privilege('anon', 'public.update_own_draft_expense_v1(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.link_expense_to_batch_v1(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preflight_expense_submission_v1(uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute the stranded-draft RPCs';
  END IF;
END
$verify$;

COMMIT;
