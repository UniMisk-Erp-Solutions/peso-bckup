-- ── PesoWise · HOTFIX: employee-safe runtime option configuration RPC
-- Migration: 20260820220000_form_template_runtime_option_configuration.sql
--
-- Phase 13 finding: the SAME unbounded-fetch risk that affects the admin
-- Form Field Template editor also affects the live expense creation/editing
-- form. ExpenseService.fetchOptionBranchesForTemplates (src/services/
-- ExpenseService.ts) does `.in("parent_template_id", templateIds)` with no
-- bound, and ExpenseForm.tsx loads the FULL result into `optionBranches`
-- state up front, then filters client-side per selected option
-- (getVisibleBranchIds). Confirmed live: the Project Unique ID template
-- (1,006 active branches) is assigned to 9 real expense categories in
-- MicroLink (Laptop Rent, Food, Hotel/Guest House, Material Purchase,
-- Mobile Recharges, Local Manpower, Travelling, Petrol Expense, Other) --
-- every expense creation in any of those categories triggers this
-- unbounded fetch today.
--
-- This migration adds the read-only, employee-safe RPC this runtime path
-- needs (get_runtime_form_option_configuration) so a future pass can
-- rewire ExpenseForm.tsx onto an on-demand, per-selected-option model --
-- mirroring get_form_template_parent_option_configuration (admin-only)
-- exactly, but authorized for any active org member, not just admins.
--
-- NOT WIRED INTO THE FRONTEND YET. Rewiring ExpenseForm.tsx (and its
-- sibling consumers: BatchSharedCategoryFields.tsx, batchExpenseReview.ts,
-- loadCorrectionCustomFields.ts) onto this RPC is deliberately left for a
-- focused follow-up rather than rushed into this hotfix -- an error in the
-- live expense-submission path would be materially worse than the current
-- truncation bug. This RPC is purely additive and inert until called.

CREATE OR REPLACE FUNCTION public.get_runtime_form_option_configuration (
  p_organization_id     uuid,
  p_template_id         uuid,
  p_parent_option_value text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branches jsonb;
BEGIN
  -- Employee-safe: any ACTIVE member of the template's own organization may
  -- call this -- not admin-only, unlike the editor RPCs. No cross-org, no
  -- retired configuration, no admin-only metadata (revision history,
  -- retired_by/retired_reason) is ever returned.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = p_organization_id
      AND user_id         = auth.uid()
      AND is_active        = true
  ) THEN
    RAISE EXCEPTION 'Permission denied: active membership required in organisation %',
      p_organization_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_form_field_templates
    WHERE id = p_template_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  WITH RECURSIVE option_branches AS (
    SELECT * FROM public.expense_form_field_option_branches
    WHERE  parent_template_id  = p_template_id
      AND  organization_id     = p_organization_id
      AND  parent_option_value = p_parent_option_value
      AND  parent_branch_id    IS NULL
      AND  retired_at          IS NULL
    UNION ALL
    SELECT b.* FROM public.expense_form_field_option_branches b
    JOIN   option_branches ob ON b.parent_branch_id = ob.id
    WHERE  b.retired_at IS NULL
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'id',                  id,
      'parent_branch_id',    parent_branch_id,
      'parent_option_value', parent_option_value,
      'field_key',           field_key,
      'name',                name,
      'field_type',          field_type,
      'required',            required,
      'placeholder',         placeholder,
      'help_text',           help_text,
      'default_value',       default_value,
      'validation_rules',    validation_rules,
      'options',             options,
      'display_order',       display_order
    )
    ORDER BY display_order
  )
  INTO v_branches
  FROM option_branches;

  RETURN jsonb_build_object(
    'parent_option_value', p_parent_option_value,
    'branches',            COALESCE(v_branches, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL   ON FUNCTION public.get_runtime_form_option_configuration FROM PUBLIC;
REVOKE ALL   ON FUNCTION public.get_runtime_form_option_configuration FROM anon;
GRANT EXECUTE ON FUNCTION public.get_runtime_form_option_configuration TO authenticated;

COMMENT ON FUNCTION public.get_runtime_form_option_configuration IS
  'DOC-097 hotfix. Employee-safe (any active org member, not admin-only), '
  'read-only, on-demand fetch of ONE parent option''s active branch tree for '
  'the runtime expense form. Not yet wired into any frontend consumer -- '
  'see this migration''s header comment.';

NOTIFY pgrst, 'reload schema';
