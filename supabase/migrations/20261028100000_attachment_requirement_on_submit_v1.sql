-- DOC-150 -- AUTHORITATIVE bill/receipt requirement at the moment an expense becomes 'submitted'.
--
-- The organisation rule is: amount > organization_settings.attachment_required_above_amount
-- requires at least one valid bill attachment. Until now ONLY the legacy browser flow checked it:
-- no server function (submit_microlink_expense_v1 / _persist_microlink_expense_snapshot_v1 /
-- submit_microlink_expense_batch_v1 / admin submit) and no trigger read the threshold or looked
-- at attachments. A MicroLink expense of Rs 800 (threshold Rs 499) was submitted on 2026-10-02
-- with ZERO active attachments: its bill had been uploaded, then removed in the form (soft-deleted
-- 15:57:02), and the form's "does a bill exist" query did not filter deleted rows.
--
-- Fix: a DEFERRED constraint trigger on the status transition into 'submitted' (same mechanism and
-- timing as validate_custom_fields_on_submit_*). It covers EVERY path at once - MicroLink atomic
-- single, legacy single, draft -> submit, rejected -> resubmit, withdrawn -> resubmit, direct
-- PostgREST updates - and rolls the whole transaction back, so a rejected NEW submit leaves no row.
--
-- Valid attachment = a row of THIS expense, not soft-deleted, with a persisted reference
-- (storage_path OR file_url; 7,984 legacy rows carry only file_url). Another expense's bill, a
-- deleted bill and a temp upload that has no attachment row never count.
--
-- The only exception is an organisation in a restore window (is_organization_locked_for_restore_v1).
-- There is NO admin exemption: admin submit-for-employee is attach-first
-- (20261029100000_admin_submit_attach_first_v1.sql).
-- No historical row is touched. Nothing is rejected retroactively.

BEGIN;

CREATE OR REPLACE FUNCTION public.validate_expense_attachment_requirement_v1(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org       uuid;
  v_amount    numeric;
  v_threshold numeric;
  v_valid     integer;
BEGIN
  SELECT e.organization_id, e.total_amount INTO v_org, v_amount
  FROM public.expenses e WHERE e.id = p_expense_id;
  IF v_org IS NULL THEN
    RETURN;  -- expense gone; nothing to validate
  END IF;

  SELECT s.attachment_required_above_amount INTO v_threshold
  FROM public.organization_settings s WHERE s.organization_id = v_org;

  -- No configured threshold, or the amount is at/below it: no bill required.
  IF v_threshold IS NULL OR COALESCE(v_amount, 0) <= v_threshold THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_valid
  FROM public.attachments a
  WHERE a.expense_id = p_expense_id
    AND a.deleted_at IS NULL
    AND (btrim(COALESCE(a.storage_path, '')) <> '' OR btrim(COALESCE(a.file_url, '')) <> '');

  IF v_valid = 0 THEN
    RAISE EXCEPTION 'Bill photos are required for expenses above ₹%. Please upload at least one receipt or bill before submitting.',
      trim(trailing '.' FROM trim(trailing '0' FROM to_char(v_threshold, 'FM9999999990.00')))
      USING ERRCODE = '23514',
            HINT = 'attachment_required',
            DETAIL = 'ATTACHMENT_REQUIRED threshold=' || v_threshold::text || ' amount=' || COALESCE(v_amount, 0)::text;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_validate_expense_attachment_requirement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'submitted'
     AND NOT public.is_organization_locked_for_restore_v1(NEW.organization_id) THEN
    PERFORM public.validate_expense_attachment_requirement_v1(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_expense_attachment_requirement_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_expense_attachment_requirement_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.validate_expense_attachment_requirement_v1(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.trg_validate_expense_attachment_requirement() FROM PUBLIC;

DROP TRIGGER IF EXISTS validate_attachment_on_submit_insert ON public.expenses;
CREATE CONSTRAINT TRIGGER validate_attachment_on_submit_insert
  AFTER INSERT ON public.expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'submitted')
  EXECUTE FUNCTION public.trg_validate_expense_attachment_requirement();

DROP TRIGGER IF EXISTS validate_attachment_on_submit_update ON public.expenses;
CREATE CONSTRAINT TRIGGER validate_attachment_on_submit_update
  AFTER UPDATE OF status ON public.expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_validate_expense_attachment_requirement();

COMMENT ON FUNCTION public.validate_expense_attachment_requirement_v1(uuid) IS
  'Raises 23514 (hint attachment_required) when the expense exceeds the org attachment threshold and has no live attachment with a persisted reference. DOC-150.';

DO $verify$
BEGIN
  IF to_regprocedure('public.validate_expense_attachment_requirement_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'validator missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.expenses'::regclass AND tgname IN ('validate_attachment_on_submit_insert', 'validate_attachment_on_submit_update')) <> 2 THEN
    RAISE EXCEPTION 'attachment triggers missing';
  END IF;
  IF has_function_privilege('anon', 'public.validate_expense_attachment_requirement_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute the validator';
  END IF;
END
$verify$;

COMMIT;
