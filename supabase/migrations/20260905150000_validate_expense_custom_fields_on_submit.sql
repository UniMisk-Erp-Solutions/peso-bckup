-- ── PesoWise · INCIDENT hotfix (2026-09): server-side custom-field completeness ──
-- Migration: 20260905150000_validate_expense_custom_fields_on_submit.sql
--
-- INCIDENT: Project Unique ID / Project ID / Project Name (and, in general,
-- any category's required custom form field) could be silently dropped on
-- save via at least three independent client-side defects (a pending
-- on-demand branch-config fetch treated as "nothing configured"; the edit/
-- resubmit bootstrap never re-fetching branch DEFINITIONS for an already-
-- selected option; and ExpenseService.submitExpenseBatch transitioning an
-- expense to 'submitted' BEFORE writing its custom field values, with no
-- rollback if that later write failed). All of those have now been fixed on
-- the client (see ExpenseForm.tsx, CategoryFormFieldsSection.tsx,
-- useOnDemandOptionBranches.ts, AdminSubmitExpense.tsx,
-- ExpenseService.submitExpenseBatch — all "INCIDENT hotfix (2026-09)").
--
-- But per this incident's governing rule, the browser must never be the
-- final authority. This migration adds the SERVER-SIDE, canonical guarantee
-- requested: no expense can reach `status = 'submitted'` while its
-- authoritative required custom field configuration is incomplete —
-- regardless of which of the four submission paths (single/edit, batch,
-- admin-delegated, or any future path) performed the write, and regardless
-- of whether the browser has been patched, is buggy, or is bypassed
-- entirely by a direct API call.
--
-- ── Design ───────────────────────────────────────────────────────────────
--
-- validate_expense_custom_fields_for_submission_v1(p_expense_id) is the ONE
-- canonical validator. It derives the authoritative required/visible
-- configuration entirely from the database — organization_id, the expense's
-- resolved category, expense_category_form_fields, expense_form_field_templates,
-- and expense_form_field_option_branches — and NEVER trusts anything the
-- browser claims about what is required or visible. It reproduces the
-- application's EXISTING, already-tested requiredness semantics exactly
-- (proven from code, not guessed):
--   effectiveRequired = COALESCE(assignment.required, template.required)
-- — the same nullish-coalescing fallback implemented identically in
-- BatchLineFormFields.tsx:100, expenseBatchValidation.ts:336/380,
-- loadCorrectionCustomFields.ts:135/268, and asserted directly by tests
-- CC-5/CC-6 in src/lib/__tests__/correctionCustomFields.test.ts. A field
-- whose effective show_on_submit resolves to false is never asked at
-- submit time by any client path (ExpenseForm.tsx's fetchCategoryFormFields,
-- CategoryFormFieldsSection) and is therefore excluded from this check too
-- — this validator enforces exactly what the app already promises the user,
-- nothing stricter and nothing looser.
--
-- For a select-type template with a saved value, the validator resolves the
-- EXACT branch configuration for that specific value (never "some branch
-- somewhere for this template") via a depth-limited recursive walk of
-- parent_option_value / parent_branch_id, mirroring
-- src/lib/conditionalFormFields.ts's getVisibleBranches and the
-- MAX_CONDITIONAL_BRANCH_DEPTH = 3 constant, and requires a non-empty value
-- for every branch along that resolved chain whose own `required` flag is
-- true.
--
-- The validator is invoked from a DEFERRABLE INITIALLY DEFERRED constraint
-- trigger on public.expenses, firing whenever a row's status is written as
-- 'submitted' (on INSERT, or on an UPDATE that changes status into
-- 'submitted'). It is deferred — rather than an immediate BEFORE trigger —
-- specifically because the four existing submission paths do not agree on
-- write order within a transaction: admin_submit_expense_for_employee_v2
-- inserts the expense row as 'submitted' and THEN writes custom field
-- values, all inside one transaction (see that migration's own header:
-- "Every later step in this function ... either commits alongside this
-- insert or rolls it back with everything else"). A deferred trigger
-- correctly sees the FINAL, fully-written state of the transaction at
-- commit time regardless of statement order inside it, while an immediate
-- trigger would falsely reject that already-correct, already-atomic RPC.
-- For the two paths that use separate round trips (ExpenseForm.tsx's own
-- save-then-submit, and the now-reordered submitExpenseBatch), each
-- round trip is its own autocommitted transaction, so "deferred to commit"
-- and "immediate" are equivalent in practice — the deferred trigger is a
-- strict superset of correctness, never a weaker check.
--
-- A validation failure raises an exception, which — for a deferred
-- constraint trigger — aborts the entire enclosing transaction: the status
-- change (and, for admin_submit_expense_for_employee_v2, the whole expense
-- creation, audit rows, and notifications alongside it) is rolled back. No
-- partially-submitted, partially-complete expense can ever be committed.
--
-- ── Scope / blast-radius notes ──────────────────────────────────────────
-- - The trigger's WHEN clause only fires when a row's status TRANSITIONS
--   into 'submitted' (on INSERT, or when OLD.status IS DISTINCT FROM
--   NEW.status) — not on every subsequent unrelated edit of an
--   already-submitted row. This keeps the blast radius to the one moment
--   this incident is actually about (a NEW submission) and avoids
--   retroactively blocking innocuous edits to legacy submitted expenses
--   that predate a field being marked required.
-- - A category with no expense_categories row (legacy/free-text category
--   values that never migrated into the categories table) has nothing
--   configured and is treated as nothing-to-validate, matching
--   replace_expense_form_field_values's own existing "soft category
--   validation" (section 7.11 of that function) and the client's identical
--   fallback behavior.
-- - This migration does NOT touch replace_expense_form_field_values,
--   admin_submit_expense_for_employee_v2, or any other existing function —
--   forward-only: the invariant is added purely as a new, additive guard
--   that every existing write path must already satisfy once its own
--   client-side fix (already applied in this branch) is deployed alongside
--   it.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. Canonical validator -----------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_expense_custom_fields_for_submission_v1(
  p_expense_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org_id uuid;
  v_category text;
  v_category_id uuid;
  v_missing text[] := ARRAY[]::text[];
  v_assignment RECORD;
  v_effective_required boolean;
  v_effective_show_on_submit boolean;
  v_template_value text;
  v_branch RECORD;
BEGIN
  SELECT organization_id, category::text
    INTO v_org_id, v_category
  FROM public.expenses
  WHERE id = p_expense_id;

  IF NOT FOUND OR v_org_id IS NULL THEN
    -- The row this validator was asked about doesn't exist / has no org —
    -- nothing this function can authoritatively check. The trigger that
    -- calls this only does so for a row it just wrote, so this should not
    -- occur in practice; fail open rather than block on an impossible state.
    RETURN;
  END IF;

  -- Same category resolution as replace_expense_form_field_values (7.11)
  -- and the client's own category lookup: case-insensitive name match.
  -- Legacy/free-text categories with no matching row have nothing
  -- configured — nothing to validate, matching existing behavior exactly.
  SELECT c.id INTO v_category_id
  FROM public.expense_categories c
  WHERE c.organization_id = v_org_id
    AND lower(c.name) = lower(COALESCE(v_category, ''))
  LIMIT 1;

  IF v_category_id IS NULL THEN
    RETURN;
  END IF;

  FOR v_assignment IN
    SELECT
      cff.template_id,
      cff.required AS assignment_required,
      cff.show_on_submit AS assignment_show_on_submit,
      t.required AS template_required,
      t.show_on_submit AS template_show_on_submit,
      t.name AS template_name,
      t.field_type AS field_type
    FROM public.expense_category_form_fields cff
    JOIN public.expense_form_field_templates t ON t.id = cff.template_id
    WHERE cff.category_id = v_category_id
      AND cff.organization_id = v_org_id
  LOOP
    -- Reproduces (submitFlag ?? templateSubmitFlag ?? true) === true from
    -- ExpenseForm.tsx's fetchCategoryFormFields and useBatchFieldPlan's
    -- isAssignmentVisible: a field the app never shows at submit time can
    -- never block submission.
    v_effective_show_on_submit := COALESCE(
      v_assignment.assignment_show_on_submit,
      v_assignment.template_show_on_submit,
      true
    );
    IF NOT v_effective_show_on_submit THEN
      CONTINUE;
    END IF;

    -- Reproduces assignment.required ?? template.required — proven, not
    -- guessed, from BatchLineFormFields.tsx:100, expenseBatchValidation.ts,
    -- loadCorrectionCustomFields.ts, and tests CC-5/CC-6.
    v_effective_required := COALESCE(
      v_assignment.assignment_required,
      v_assignment.template_required,
      false
    );

    SELECT v.field_value INTO v_template_value
    FROM public.expense_form_field_values v
    WHERE v.expense_id = p_expense_id
      AND v.template_id = v_assignment.template_id;

    IF v_effective_required AND (v_template_value IS NULL OR btrim(v_template_value) = '') THEN
      v_missing := array_append(v_missing, v_assignment.template_name);
    END IF;

    -- For a select-type field WITH a saved value, resolve the EXACT active
    -- branch configuration for that value from the database — never trust
    -- which branches the browser thinks are visible. Depth-limited to match
    -- MAX_CONDITIONAL_BRANCH_DEPTH (src/lib/conditionalFormFieldTypes.ts).
    IF v_assignment.field_type = 'select'
       AND v_template_value IS NOT NULL
       AND btrim(v_template_value) <> ''
    THEN
      FOR v_branch IN
        WITH RECURSIVE branch_tree AS (
          SELECT b.id, b.name, b.required, 1 AS depth
          FROM public.expense_form_field_option_branches b
          WHERE b.organization_id = v_org_id
            AND b.parent_template_id = v_assignment.template_id
            AND b.parent_branch_id IS NULL
            AND b.parent_option_value = v_template_value
            AND b.retired_at IS NULL

          UNION ALL

          SELECT child.id, child.name, child.required, parent.depth + 1
          FROM public.expense_form_field_option_branches child
          JOIN branch_tree parent ON child.parent_branch_id = parent.id
          JOIN public.expense_form_field_values pv
            ON pv.branch_field_id = parent.id
           AND pv.expense_id = p_expense_id
          WHERE child.organization_id = v_org_id
            AND child.parent_option_value = pv.field_value
            AND child.retired_at IS NULL
            AND parent.depth < 3
        )
        SELECT id, name, required FROM branch_tree
      LOOP
        IF v_branch.required THEN
          IF NOT EXISTS (
            SELECT 1
            FROM public.expense_form_field_values v
            WHERE v.expense_id = p_expense_id
              AND v.branch_field_id = v_branch.id
              AND v.field_value IS NOT NULL
              AND btrim(v.field_value) <> ''
          ) THEN
            v_missing := array_append(v_missing, v_branch.name);
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'Cannot submit: required additional field(s) missing: %', array_to_string(v_missing, ', ')
      USING ERRCODE = '23514',
            HINT = 'Complete the required additional fields before submitting.';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.validate_expense_custom_fields_for_submission_v1(uuid) IS
  'INCIDENT (2026-09) canonical server-side check: raises if any custom form '
  'field required for this expense''s category (reproducing assignment.required '
  '?? template.required, and the exact active branch configuration for whatever '
  'select value is saved) is missing a non-empty value. Never trusts the '
  'browser for what is required or visible. Invoked by '
  'trg_validate_expense_custom_fields_on_submit; not RLS-restricted callers-only '
  '(SECURITY DEFINER) since it must see the full authoritative config regardless '
  'of the calling user''s own row visibility.';

-- SECURITY: this is an internal helper invoked only via the trigger below
-- (a SECURITY DEFINER function calling another function checks EXECUTE
-- against the CALLING function's own effective role, not the original
-- end-user role, so revoking here does not affect the trigger's own
-- internal PERFORM call). It must never be a directly callable public RPC:
-- it takes a bare expense_id with no ownership/authorization check of its
-- own (by design — it only ever needs to be trustworthy from inside the
-- trigger, which already only fires on a row PostgREST/RLS already allowed
-- someone to write), and it would otherwise let anon/authenticated probe
-- arbitrary expense IDs across organizations for custom-field completeness
-- and field names. New functions default to PUBLIC-executable in Postgres,
-- matching this codebase's own documented prior grant-hygiene gap (DOC-099)
-- that this migration must not repeat.
REVOKE ALL ON FUNCTION public.validate_expense_custom_fields_for_submission_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_expense_custom_fields_for_submission_v1(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.validate_expense_custom_fields_for_submission_v1(uuid) FROM authenticated;

-- 2. Trigger wiring -----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_validate_expense_custom_fields_on_submit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'submitted' THEN
    PERFORM public.validate_expense_custom_fields_for_submission_v1(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_validate_expense_custom_fields_on_submit() IS
  'INCIDENT (2026-09) trigger wrapper for validate_expense_custom_fields_for_submission_v1. '
  'Deferred to transaction commit (see the DEFERRABLE INITIALLY DEFERRED constraint '
  'trigger below) so it correctly sees the final state regardless of whether a '
  'given submission path writes custom field values before or after the status '
  'transition within the same transaction.';

-- Postgres does not allow a WHEN clause to reference OLD on a trigger that
-- also fires for INSERT (OLD does not exist for that event) — so this is
-- two separate constraint triggers rather than one combined INSERT/UPDATE
-- trigger, even though they share the same underlying function.

DROP TRIGGER IF EXISTS validate_custom_fields_on_submit_insert ON public.expenses;
DROP TRIGGER IF EXISTS validate_custom_fields_on_submit_update ON public.expenses;
DROP TRIGGER IF EXISTS validate_custom_fields_on_submit ON public.expenses; -- pre-fix name, in case a prior apply attempt left it

CREATE CONSTRAINT TRIGGER validate_custom_fields_on_submit_insert
  AFTER INSERT ON public.expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'submitted')
  EXECUTE FUNCTION public.trg_validate_expense_custom_fields_on_submit();

CREATE CONSTRAINT TRIGGER validate_custom_fields_on_submit_update
  AFTER UPDATE OF status ON public.expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_validate_expense_custom_fields_on_submit();
