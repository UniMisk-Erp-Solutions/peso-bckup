-- ── PesoWise · organization mandatory expense fields + post-submission guard ──
-- Migration: 20260907120000_organization_required_expense_fields.sql
--
-- WHY THIS EXISTS
--
-- DOC-117's validator enforces the requiredness that the *category form
-- configuration* declares, at the moment an expense transitions into
-- `submitted`. Two independent gaps remain, and this migration closes both.
--
-- GAP 1 — "required for every category in this organization" is inexpressible.
--   It could only be written as N `expense_category_form_fields` rows kept in
--   sync by hand; a category added later silently opts out. Worse, the category
--   path resolves `expenses.category` (a text column) to a category row BY
--   NAME, so a row whose category string no longer matches any category
--   resolves to ZERO requirements and passes unchecked. Production carries two
--   such orphan strings left behind by category renames.
--
-- GAP 2 — enforcement only fires on the status transition. An expense that is
--   ALREADY `submitted` can have its custom-field rows deleted or blanked
--   without any status change, and nothing re-validates. This is not
--   theoretical: `replace_expense_form_field_values` authorises the OWNER to
--   rewrite values while status is 'draft', 'submitted' or 'rejected', and a
--   Production expense was observed submitted complete at 10:55 and stripped of
--   both dependent project values at 10:59 the same morning, with the browser's
--   own draft still holding them.
--
-- NO ORGANIZATION NAME APPEARS ANYWHERE IN THIS FILE. The mechanism is generic;
-- opting a specific organization in is data, applied by the companion migration.
--
-- ── Scope / blast radius ────────────────────────────────────────────────────
--   * Forward-looking only. Installing this does NOT scan, validate, repair or
--     modify a single existing row. Both enforcement points are triggers; they
--     fire only on future events.
--   * An organization with no policy rows behaves EXACTLY as before.
--   * No DML against any business table. No destructive DDL. No change to
--     verification, approval, override, balance, Tally or reporting logic. This
--     governs two questions only: may this expense ENTER the submitted
--     workflow, and may a write leave a protected expense incomplete?

BEGIN;

-- ── 1. the policy table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.organization_required_expense_fields (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL
                               REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Stable identifier for the parent field. Templates in this schema carry an
  -- empty `field_key`, so the template UUID is the only stable handle; mutable
  -- display names are never used for identification.
  --
  -- ON DELETE RESTRICT, deliberately: this is a MUST-HAVE policy, and letting a
  -- template deletion silently cascade the policy away would silently disable
  -- enforcement. Removing a policy must be an explicit DELETE from this table.
  -- Deleting the ORGANIZATION still cascades naturally above.
  template_id                uuid NOT NULL
                               REFERENCES public.expense_form_field_templates(id) ON DELETE RESTRICT,
  required                   boolean NOT NULL DEFAULT true,
  -- Dependent branch fields are per-option rows, so they cannot be named by a
  -- fixed UUID. `field_key` IS stable across every option of a given dependent
  -- field, so it is the correct stable handle here.
  --
  -- A branch is required when EITHER its own `required` flag is true (existing
  -- behaviour) OR its field_key appears here. Listing a key additionally means
  -- the CONFIGURATION for that key must exist and be unambiguous for whichever
  -- option is selected — see validate_expense_org_required_fields_v1.
  required_branch_field_keys text[] NOT NULL DEFAULT '{}'::text[],
  notes                      text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_required_expense_fields_unique
    UNIQUE (organization_id, template_id)
);

COMMENT ON TABLE public.organization_required_expense_fields IS
  'Organization-scoped policy: a form-field template that is mandatory on EVERY '
  'expense of the organization, independent of category configuration. Enforced '
  'on entry into the submitted workflow and on every later custom-field write '
  'while the expense stays in a protected status. An organization with no rows '
  'here is completely unaffected.';

COMMENT ON COLUMN public.organization_required_expense_fields.required_branch_field_keys IS
  'Stable branch field_key values that must be non-blank for whichever option is '
  'selected, in addition to any branch already flagged required. A listed key '
  'whose branch configuration is missing or ambiguous for the selected option '
  'fails CLOSED (SQLSTATE PW002) rather than silently passing.';

CREATE INDEX IF NOT EXISTS organization_required_expense_fields_org_idx
  ON public.organization_required_expense_fields (organization_id);

DROP TRIGGER IF EXISTS update_org_required_expense_fields_updated_at
  ON public.organization_required_expense_fields;
CREATE TRIGGER update_org_required_expense_fields_updated_at
  BEFORE UPDATE ON public.organization_required_expense_fields
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.organization_required_expense_fields ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.organization_required_expense_fields FROM PUBLIC;
REVOKE ALL ON TABLE public.organization_required_expense_fields FROM anon;
REVOKE ALL ON TABLE public.organization_required_expense_fields FROM authenticated;
GRANT SELECT ON TABLE public.organization_required_expense_fields TO service_role;

-- ── 2. which statuses must stay complete ────────────────────────────────────
--
-- Derived from the live `expense_status` enum and the actual review gates, not
-- guessed. `draft`, `rejected` and `edited` are the states in which the app
-- legitimately lets a user hold an incomplete expense while editing; everything
-- from `submitted` onward is in the review/approval pipeline and must stay
-- complete. Re-entering `submitted` from an editable state is separately gated
-- by the status triggers, so an incomplete edit can never be promoted.

CREATE OR REPLACE FUNCTION public._expense_status_is_protected_v1(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_status IN (
    'submitted', 'under_review', 'verified',
    'level_1_verified', 'level_2_verified',
    'approved', 'paid'
  );
$$;

COMMENT ON FUNCTION public._expense_status_is_protected_v1(text) IS
  'Statuses in which an expense is inside the review/approval workflow and its '
  'mandatory custom fields must remain complete. draft/rejected/edited are '
  'deliberately excluded: those are the editing states.';

-- ── 3. the organization policy validator ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.validate_expense_org_required_fields_v1(
  p_expense_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_org      uuid;
  v_missing  text[] := '{}'::text[];
  v_badcfg   text[] := '{}'::text[];
  r          record;
  k          text;
  v_value    text;
  v_label    text;
  v_defs     integer;
BEGIN
  SELECT e.organization_id INTO v_org
  FROM public.expenses e WHERE e.id = p_expense_id;

  IF v_org IS NULL THEN
    RETURN;                              -- expense gone; nothing to enforce
  END IF;

  -- Fast exit for every organization that has not opted in, so this is a
  -- genuine no-op for other tenants.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_required_expense_fields p
    WHERE p.organization_id = v_org AND p.required
  ) THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT p.template_id, p.required_branch_field_keys, t.name AS template_name
    FROM public.organization_required_expense_fields p
    JOIN public.expense_form_field_templates t ON t.id = p.template_id
    WHERE p.organization_id = v_org AND p.required
    ORDER BY t.name
  LOOP
    -- (a) the parent field itself must carry a genuinely non-blank value.
    --     NULL, '' and whitespace-only are all rejected, as is a missing row.
    --     Duplicate rows for the same template exist in historical data, so
    --     this deliberately looks for ANY non-blank value rather than taking an
    --     arbitrary first row that might happen to be blank.
    SELECT btrim(v.field_value)
    INTO v_value
    FROM public.expense_form_field_values v
    WHERE v.expense_id = p_expense_id
      AND v.template_id = r.template_id
      AND NULLIF(btrim(v.field_value), '') IS NOT NULL
    ORDER BY v.created_at DESC NULLS LAST
    LIMIT 1;

    IF v_value IS NULL THEN
      v_missing := v_missing || r.template_name;
      CONTINUE;                          -- dependents are undefined without it
    END IF;

    -- (b) CONFIGURATION check, fail-closed. For every mandatory dependent key
    --     there must be exactly ONE active branch definition reachable for the
    --     option actually selected. Zero means an administrator created an
    --     option without the mandatory dependent field — accepting the expense
    --     would silently bypass the policy. More than one is ambiguous. Both
    --     are configuration errors, not user errors.
    FOREACH k IN ARRAY r.required_branch_field_keys LOOP
      SELECT count(*) INTO v_defs
      FROM public.expense_form_field_option_branches b
      WHERE b.organization_id = v_org
        AND b.parent_template_id = r.template_id
        AND b.parent_option_value = v_value
        AND b.retired_at IS NULL
        AND b.field_key = k;

      IF v_defs <> 1 THEN
        v_badcfg := v_badcfg || (r.template_name || ' -> ' || k ||
                                 ' (' || v_defs || ' active definitions)');
      END IF;
    END LOOP;

    -- (c) the dependent branches ACTIVE for the value actually selected. The
    --     selected value decides the branch set — never the submitted payload.
    FOR v_label IN
      SELECT b.name
      FROM public.expense_form_field_option_branches b
      WHERE b.organization_id = v_org
        AND b.parent_template_id = r.template_id
        AND b.parent_option_value = v_value
        AND b.retired_at IS NULL
        AND (b.required OR b.field_key = ANY (r.required_branch_field_keys))
        AND NOT EXISTS (
          SELECT 1 FROM public.expense_form_field_values v2
          WHERE v2.expense_id = p_expense_id
            AND v2.branch_field_id = b.id
            AND NULLIF(btrim(v2.field_value), '') IS NOT NULL
        )
      ORDER BY b.display_order, b.name
    LOOP
      v_missing := v_missing || v_label;
    END LOOP;
  END LOOP;

  -- A configuration fault is reported first and separately: it is not something
  -- the submitting user can fix, so it must not be dressed up as "you forgot a
  -- field". DETAIL carries display names and keys only — never SQL, table
  -- names, ids or any other internal.
  IF array_length(v_badcfg, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Required project configuration is incomplete. Please contact an administrator.'
      USING ERRCODE = 'PW002',
            DETAIL  = 'Unconfigured or ambiguous: ' || array_to_string(v_badcfg, '; ') || '.',
            HINT    = 'An administrator must configure the mandatory dependent fields for this option.';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Required project details are incomplete.'
      USING ERRCODE = 'PW001',
            DETAIL  = 'Missing: ' || array_to_string(v_missing, ', ') || '.',
            HINT    = 'Complete the required project details before submitting this expense.';
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.validate_expense_org_required_fields_v1(uuid) IS
  'Organization-level mandatory expense-field policy. Reconstructs the required '
  'parent field and its active dependent branches for the SELECTED option value '
  'entirely from organization_required_expense_fields plus branch configuration, '
  'never from the submitted payload. No-op for organizations with no policy rows. '
  'PW001 = the user is missing a value. PW002 = the configuration itself cannot '
  'satisfy the policy (fails closed).';

REVOKE ALL ON FUNCTION public.validate_expense_org_required_fields_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_expense_org_required_fields_v1(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.validate_expense_org_required_fields_v1(uuid) FROM authenticated;

-- ── 4. ONE canonical rule, used by BOTH enforcement points ──────────────────
--
-- The database must not contain one rule for "entering submitted" and a
-- slightly different one for "editing values afterwards". Both call this.

CREATE OR REPLACE FUNCTION public.validate_expense_submission_invariants_v1(
  p_expense_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Organization policy first: for an opted-in tenant its deterministic PW001 /
  -- PW002 is the message the application should surface, rather than the
  -- generic 23514 check_violation the category validator raises. For every
  -- other tenant this is a no-op and behaviour below is unchanged.
  PERFORM public.validate_expense_org_required_fields_v1(p_expense_id);
  PERFORM public.validate_expense_custom_fields_for_submission_v1(p_expense_id);
END;
$$;

COMMENT ON FUNCTION public.validate_expense_submission_invariants_v1(uuid) IS
  'The single canonical completeness rule for an expense inside the submitted '
  'workflow: organization mandatory-field policy plus DOC-117 category '
  'configuration. Called by the status-transition triggers on public.expenses '
  'and by the value-mutation guard on public.expense_form_field_values, so the '
  'two enforcement points can never drift apart.';

REVOKE ALL ON FUNCTION public.validate_expense_submission_invariants_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_expense_submission_invariants_v1(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.validate_expense_submission_invariants_v1(uuid) FROM authenticated;

-- ── 5. enforcement point 1: entering the submitted workflow ─────────────────
--
-- DOC-117's wrapper, now delegating to the canonical rule. The two DEFERRABLE
-- INITIALLY DEFERRED constraint triggers it is attached to are NOT recreated
-- here, so their firing rules and deferral semantics stay exactly as proven.

CREATE OR REPLACE FUNCTION public.trg_validate_expense_custom_fields_on_submit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'submitted' THEN
    PERFORM public.validate_expense_submission_invariants_v1(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_validate_expense_custom_fields_on_submit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_validate_expense_custom_fields_on_submit() FROM anon;
REVOKE ALL ON FUNCTION public.trg_validate_expense_custom_fields_on_submit() FROM authenticated;

-- ── 6. enforcement point 2: mutating values of a protected expense ──────────
--
-- Deferred to commit, so the DELETE-then-INSERT replacement every writer
-- performs (replace_expense_form_field_values,
-- replace_expense_form_field_values_by_reviewer,
-- admin_restore_upsert_form_field_values) is judged on its FINAL state: a
-- complete swap passes, a swap that ends up missing something rolls the whole
-- transaction back.
--
-- On DELETE there is no NEW, so the owning expense comes from OLD. On an UPDATE
-- that moves a row between expenses, BOTH sides are checked so a row cannot be
-- stolen away and leave the old expense incomplete.

CREATE OR REPLACE FUNCTION public.trg_protect_required_fields_after_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ids    uuid[] := '{}'::uuid[];
  v_id     uuid;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.expense_id];
  ELSIF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.expense_id];
  ELSE  -- UPDATE
    v_ids := ARRAY[NEW.expense_id];
    IF OLD.expense_id IS DISTINCT FROM NEW.expense_id THEN
      v_ids := v_ids || OLD.expense_id;
    END IF;
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    CONTINUE WHEN v_id IS NULL;

    SELECT e.status::text INTO v_status
    FROM public.expenses e WHERE e.id = v_id;

    -- The expense may legitimately be gone (cascade delete of the whole
    -- expense), and editable statuses are deliberately unguarded.
    CONTINUE WHEN v_status IS NULL;
    CONTINUE WHEN NOT public._expense_status_is_protected_v1(v_status);

    PERFORM public.validate_expense_submission_invariants_v1(v_id);
  END LOOP;

  RETURN NULL;   -- AFTER trigger; return value is ignored
END;
$$;

COMMENT ON FUNCTION public.trg_protect_required_fields_after_submission() IS
  'Guards custom-field values of an expense already inside the review/approval '
  'workflow. Deferred to commit, so an atomic delete-and-reinsert replacement is '
  'judged on its final state and passes when complete, while any transaction that '
  'ends with a mandatory value missing is rolled back. Editable statuses '
  '(draft/rejected/edited) are not guarded.';

REVOKE ALL ON FUNCTION public.trg_protect_required_fields_after_submission() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_protect_required_fields_after_submission() FROM anon;
REVOKE ALL ON FUNCTION public.trg_protect_required_fields_after_submission() FROM authenticated;

DROP TRIGGER IF EXISTS protect_required_fields_after_submission
  ON public.expense_form_field_values;

-- One constraint trigger covering INSERT, UPDATE and DELETE. A constraint
-- trigger may combine the three events because its function reads OLD/NEW
-- through TG_OP rather than through a WHEN clause (a WHEN referencing OLD is
-- what forced DOC-117 to split its two triggers).
--
-- Installing this validates NOTHING retroactively: it fires only on future row
-- events, so every existing historical row is untouched.
CREATE CONSTRAINT TRIGGER protect_required_fields_after_submission
  AFTER INSERT OR UPDATE OR DELETE ON public.expense_form_field_values
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_protect_required_fields_after_submission();

COMMIT;

NOTIFY pgrst, 'reload schema';
