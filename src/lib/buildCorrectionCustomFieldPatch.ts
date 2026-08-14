import type { CorrectionCustomFieldsModel } from "./loadCorrectionCustomFields";

/**
 * One atomic change instruction for a single custom field value.
 *
 * Exactly one of template_id / branch_field_id is non-null (matches the
 * DB check constraint on expense_form_field_values).
 */
export type PatchItem = {
  template_id: string | null;
  branch_field_id: string | null;
  operation: "set" | "clear";
  old_value: string | null;
  new_value: string | null;
};

/**
 * Computes an explicit, minimal patch from the diff between the initial
 * values snapshot (captured at load time) and the current values in the
 * correction dialog.
 *
 * Rules:
 *  - Fields not in the loaded model are never touched (unloaded exclusion).
 *  - A field whose current value equals its initial value produces no item.
 *  - A visible field with a new non-empty value → "set".
 *  - A visible field that was non-empty and is now empty → "clear".
 *  - An invisible branch field that had a stored value → "clear".
 *  - An invisible branch field with no stored value → excluded.
 *  - Whitespace-only strings are normalised to null before comparison.
 */
export function buildCorrectionCustomFieldPatch(
  model: Pick<
    CorrectionCustomFieldsModel,
    | "categoryFormFields"
    | "optionBranches"
    | "initialFormFieldValues"
    | "initialBranchValues"
    | "formFieldValues"
    | "branchValues"
  >,
  visibleBranchIds: Set<string>,
): PatchItem[] {
  const items: PatchItem[] = [];

  // ── Template fields ─────────────────────────────────────────────────────────
  for (const field of model.categoryFormFields) {
    const templateId = field.template.id;
    const initialNorm = norm(model.initialFormFieldValues[templateId]);
    const currentNorm = norm(model.formFieldValues[templateId]);

    if (initialNorm === currentNorm) continue;

    if (currentNorm !== null) {
      items.push({
        template_id: templateId,
        branch_field_id: null,
        operation: "set",
        old_value: initialNorm,
        new_value: currentNorm,
      });
    } else if (initialNorm !== null) {
      items.push({
        template_id: templateId,
        branch_field_id: null,
        operation: "clear",
        old_value: initialNorm,
        new_value: null,
      });
    }
  }

  // ── Branch fields ────────────────────────────────────────────────────────────
  for (const branch of model.optionBranches) {
    const branchId = branch.id;
    const initialNorm = norm(model.initialBranchValues[branchId]);

    if (!visibleBranchIds.has(branchId)) {
      // Branch is invisible: clear stored value so DB stays consistent.
      if (initialNorm !== null) {
        items.push({
          template_id: null,
          branch_field_id: branchId,
          operation: "clear",
          old_value: initialNorm,
          new_value: null,
        });
      }
      continue;
    }

    const currentNorm = norm(model.branchValues[branchId]);
    if (initialNorm === currentNorm) continue;

    if (currentNorm !== null) {
      items.push({
        template_id: null,
        branch_field_id: branchId,
        operation: "set",
        old_value: initialNorm,
        new_value: currentNorm,
      });
    } else if (initialNorm !== null) {
      items.push({
        template_id: null,
        branch_field_id: branchId,
        operation: "clear",
        old_value: initialNorm,
        new_value: null,
      });
    }
  }

  return items;
}

/** Trims and coerces empty / whitespace-only strings to null. */
function norm(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}
