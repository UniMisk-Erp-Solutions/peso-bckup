import type { SupabaseClient } from "@supabase/supabase-js";
import type { OptionBranchDefinition } from "./conditionalFormFieldTypes";
import { validateVisibleBranchFields } from "./conditionalFormFields";

export type CorrectionFieldAssignment = {
  template: {
    id: string;
    name: string;
    field_type: string;
    required: boolean;
    placeholder: string | null;
    help_text: string | null;
    validation_rules: { min?: number; max?: number } | null;
    options: string[] | null;
  };
  required: boolean | null;
};

export type CorrectionCustomFieldsModel = {
  categoryFormFields: CorrectionFieldAssignment[];
  optionBranches: OptionBranchDefinition[];
  formFieldValues: Record<string, string>;
  branchValues: Record<string, string>;
  /** Immutable snapshot captured at load time — used by buildCorrectionCustomFieldPatch to compute diffs. */
  initialFormFieldValues: Record<string, string>;
  /** Immutable snapshot captured at load time — used by buildCorrectionCustomFieldPatch to compute diffs. */
  initialBranchValues: Record<string, string>;
  /** Resolved category DB id — null when category could not be resolved. */
  categoryId: string | null;
  /** Set when category resolution fails; callers should surface this to the user. */
  loadError?: string;
};

export const EMPTY_CORRECTION_FIELDS: CorrectionCustomFieldsModel = {
  categoryFormFields: [],
  optionBranches: [],
  formFieldValues: {},
  branchValues: {},
  initialFormFieldValues: {},
  initialBranchValues: {},
  categoryId: null,
};

/**
 * Loads all correction-dialog custom field data for a given expense.
 *
 * Unlike the old approach (fetching only fields that have saved values),
 * this loads ALL configured fields for the expense's category so empty
 * configured fields are shown and all field types render correctly.
 *
 * Loading order:
 * 1. Resolve category ID from expense_categories
 * 2. Load all assigned templates in display_order from expense_category_form_fields
 * 3. In parallel: fetch option branches (for select fields) + fetch existing values
 * 4. Overlay existing template and branch values onto defaults
 */
export async function loadCorrectionCustomFields(
  supabase: SupabaseClient,
  organizationId: string,
  expenseId: string,
  categoryName: string,
): Promise<CorrectionCustomFieldsModel> {
  if (!organizationId || !categoryName) return { ...EMPTY_CORRECTION_FIELDS };

  // Step 1: Resolve category ID — exact case-insensitive match.
  // Fetch up to 2 to detect ambiguity; return loadError rather than silently returning empty.
  const { data: catRows } = await supabase
    .from("expense_categories")
    .select("id")
    .eq("organization_id", organizationId)
    .ilike("name", categoryName.trim())
    .limit(2);

  if (!catRows || catRows.length === 0) {
    return {
      ...EMPTY_CORRECTION_FIELDS,
      loadError: `Category "${categoryName}" was not found. Custom fields cannot be loaded.`,
    };
  }
  if (catRows.length > 1) {
    return {
      ...EMPTY_CORRECTION_FIELDS,
      loadError: `Multiple categories match "${categoryName}". Contact your administrator to deduplicate category names.`,
    };
  }
  const cat = catRows[0];

  // Step 2: Load assigned templates for this category in display order
  const { data: assignments, error: assignError } = await supabase
    .from("expense_category_form_fields")
    .select(`
      required,
      show_on_submit,
      expense_form_field_templates (
        id, name, field_type, required, placeholder, help_text,
        validation_rules, options, show_on_submit
      )
    `)
    .eq("organization_id", organizationId)
    .eq("category_id", cat.id)
    .order("display_order", { ascending: true });

  if (assignError || !assignments?.length) return { ...EMPTY_CORRECTION_FIELDS };

  // Load ALL assigned category fields — do NOT filter by show_on_submit.
  // Reviewers correcting an expense must see every configured field, not just
  // those shown to the submitter. The show_on_submit flag controls the employee
  // submission form only; it has no meaning here.
  const categoryFormFields: CorrectionFieldAssignment[] = (assignments as any[])
    .filter((a) => a.expense_form_field_templates != null)
    .map((a) => {
      const tpl = a.expense_form_field_templates;
      return {
        template: {
          id: tpl.id,
          name: tpl.name,
          field_type: tpl.field_type,
          required: tpl.required ?? false,
          placeholder: tpl.placeholder ?? null,
          help_text: tpl.help_text ?? null,
          validation_rules: tpl.validation_rules ?? null,
          options: tpl.options ?? null,
        },
        required: a.required ?? null,
      };
    });

  if (!categoryFormFields.length) return { ...EMPTY_CORRECTION_FIELDS, categoryId: cat.id };

  // Step 3: Collect template IDs for select fields (they may have branch children)
  const selectTemplateIds = categoryFormFields
    .filter((f) => f.template.field_type === "select")
    .map((f) => f.template.id);

  // Step 4: Parallel — fetch option branches + existing saved values
  const [branches, existingRows] = await Promise.all([
    selectTemplateIds.length > 0
      ? supabase
          .from("expense_form_field_option_branches")
          .select(
            "id, organization_id, parent_template_id, parent_option_value, parent_branch_id, " +
              "field_key, name, field_type, required, placeholder, help_text, default_value, " +
              "validation_rules, options, display_order",
          )
          .eq("organization_id", organizationId)
          .in("parent_template_id", selectTemplateIds)
          .order("display_order", { ascending: true })
          .then((r) => (r.data ?? []) as OptionBranchDefinition[])
      : Promise.resolve([] as OptionBranchDefinition[]),
    supabase
      .from("expense_form_field_values")
      .select("template_id, branch_field_id, field_value")
      .eq("expense_id", expenseId)
      .eq("organization_id", organizationId)
      .then((r) => (r.data ?? []) as Array<{ template_id: string | null; branch_field_id: string | null; field_value: string | null }>),
  ]);

  // Step 5: Build initial values — checkbox fields default to "false"
  const formFieldValues: Record<string, string> = {};
  for (const f of categoryFormFields) {
    if (f.template.field_type === "checkbox") {
      formFieldValues[f.template.id] = "false";
    }
  }

  // Step 6: Overlay existing values
  const branchValues: Record<string, string> = {};
  for (const row of existingRows) {
    if (row.template_id) {
      formFieldValues[String(row.template_id)] = String(row.field_value ?? "");
    } else if (row.branch_field_id) {
      branchValues[String(row.branch_field_id)] = String(row.field_value ?? "");
    }
  }

  // Capture immutable snapshots so buildCorrectionCustomFieldPatch can diff
  // initial vs current without ever reading stale state.
  const initialFormFieldValues: Record<string, string> = { ...formFieldValues };
  const initialBranchValues: Record<string, string> = { ...branchValues };

  return {
    categoryFormFields,
    optionBranches: branches,
    formFieldValues,
    branchValues,
    initialFormFieldValues,
    initialBranchValues,
    categoryId: cat.id,
  };
}

/**
 * Validates custom field values before saving a correction.
 * Returns ok: false with a human-readable message on the first failure.
 *
 * @param allowNested - whether nested conditional branch fields are enabled
 */
export function validateCorrectionCustomFields(
  categoryFormFields: CorrectionFieldAssignment[],
  formFieldValues: Record<string, string>,
  optionBranches: OptionBranchDefinition[],
  branchValues: Record<string, string>,
  allowNested: boolean,
): { ok: true } | { ok: false; message: string } {
  // Check required template fields (assignment-level required overrides template-level)
  for (const field of categoryFormFields) {
    const isRequired = field.required ?? field.template.required;
    if (isRequired) {
      const val = formFieldValues[field.template.id] ?? "";
      if (val.trim() === "") {
        return { ok: false, message: `"${field.template.name}" is required.` };
      }
    }
  }

  // Check visible required branch fields
  if (optionBranches.length > 0) {
    const { missing } = validateVisibleBranchFields(
      optionBranches,
      formFieldValues,
      branchValues,
      allowNested,
    );
    if (missing.length > 0) {
      return { ok: false, message: `"${missing[0]}" is required.` };
    }
  }

  return { ok: true };
}
