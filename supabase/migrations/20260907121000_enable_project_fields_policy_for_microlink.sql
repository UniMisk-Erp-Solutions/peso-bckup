-- ── PesoWise · enable the mandatory project-field policy for ONE organization ──
-- Migration: 20260907121000_enable_project_fields_policy_for_microlink.sql
--
-- Companion to 20260907120000_organization_required_expense_fields.sql. That
-- migration installs the generic mechanism; this one is pure configuration
-- DATA that opts a single organization into it. They are deliberately separate
-- so the mechanism can be deployed and observed before any tenant is enforced,
-- and so enablement can be reverted with a one-row DELETE without touching the
-- validator.
--
-- The organization is addressed by its stable UUID, not by its name — names are
-- mutable and this file must keep working if the organization is renamed. The
-- guard below asserts the row exists before inserting, so applying this file
-- against a database that does not contain that organization is a clear,
-- immediate failure rather than a silent no-op.
--
-- The parent field is addressed by its template UUID (templates carry an empty
-- field_key in this schema, so the UUID is the only stable handle). The two
-- dependent fields are addressed by their branch `field_key` values, which are
-- stable across all 500+ per-option branch rows and independent of the mutable
-- display names.
--
-- Effect: every expense of this organization must carry a non-blank value for
-- the parent field, plus non-blank values for the dependent branches active for
-- whichever option was selected — on EVERY category, including any category
-- created later, and including expenses whose `category` text no longer matches
-- a category row. Enforced only on a transition into `submitted`.
--
-- NO business data is read, written, updated or deleted. Drafts, historical
-- submitted/approved expenses, balances, approvals and reports are untouched.

BEGIN;

DO $$
DECLARE
  v_org      constant uuid := '6709c1fe-e8c8-404d-bc68-d1edda923344';  -- verified 2026-09-07
  v_template constant uuid := '51181324-68cc-4174-bbe0-4834e5e22c48';  -- parent: the project selector
  v_org_name text;
  v_tpl_name text;
BEGIN
  SELECT o.name INTO v_org_name FROM public.organizations o WHERE o.id = v_org;
  IF v_org_name IS NULL THEN
    RAISE EXCEPTION 'Refusing to enable: organization % does not exist in this database', v_org;
  END IF;

  SELECT t.name INTO v_tpl_name
  FROM public.expense_form_field_templates t
  WHERE t.id = v_template AND t.organization_id = v_org;
  IF v_tpl_name IS NULL THEN
    RAISE EXCEPTION 'Refusing to enable: template % does not belong to organization %',
      v_template, v_org;
  END IF;

  -- Both dependent field_keys must actually exist for this parent, otherwise the
  -- policy would demand fields the forms cannot supply.
  IF NOT EXISTS (
    SELECT 1 FROM public.expense_form_field_option_branches b
    WHERE b.organization_id = v_org AND b.parent_template_id = v_template
      AND b.retired_at IS NULL AND b.field_key = 'project_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.expense_form_field_option_branches b
    WHERE b.organization_id = v_org AND b.parent_template_id = v_template
      AND b.retired_at IS NULL AND b.field_key = 'project_name'
  ) THEN
    RAISE EXCEPTION 'Refusing to enable: dependent branch field_keys are not configured for template %',
      v_template;
  END IF;

  INSERT INTO public.organization_required_expense_fields
    (organization_id, template_id, required, required_branch_field_keys, notes)
  VALUES
    (v_org, v_template, true, ARRAY['project_id', 'project_name'],
     'Mandatory project details on every expense of this organization, on every '
     'category. Enforced only on transition into submitted. Enabled 2026-09-07 '
     'after a read-only audit confirmed all 10 active categories expose the parent '
     'field and all 237 project options used in the preceding 60 days expose both '
     'dependent branches.')
  ON CONFLICT (organization_id, template_id) DO UPDATE
    SET required                   = EXCLUDED.required,
        required_branch_field_keys = EXCLUDED.required_branch_field_keys,
        notes                      = EXCLUDED.notes,
        updated_at                 = now();

  RAISE NOTICE 'Mandatory project-field policy enabled for organization % (template "%")',
    v_org_name, v_tpl_name;
END $$;

COMMIT;
