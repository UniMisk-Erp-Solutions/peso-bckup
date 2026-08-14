/**
 * Normalized payload for the `replace_expense_form_field_values` RPC.
 *
 * Exactly one of `template_id` / `branch_field_id` is set per row, mirroring the
 * `expense_form_field_values` table constraint.
 */
export type ExpenseCustomFieldValuePayload = {
  template_id: string | null;
  branch_field_id: string | null;
  field_value: string;
};

/**
 * True when a raw form value should be persisted.
 *
 * IMPORTANT: `0` and `false` are real, savable values. Only `null`, `undefined`,
 * and the empty string ("") are treated as "not provided". We never use a
 * truthiness check here, which would wrongly drop `0` / `false`.
 */
export function isFilledCustomFieldValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return String(value) !== "";
}

type BuildPayloadArgs = {
  /** Map of templateId -> raw value (regular category fields). */
  templateValues?: Record<string, unknown> | null;
  /** Map of branchId -> raw value (conditional dropdown sub-fields). */
  branchValues?: Record<string, unknown> | null;
  /**
   * Branch ids currently visible/active. When provided, only these branch
   * values are persisted; hidden branches are dropped (replace semantics).
   * When omitted, all filled branch values are included.
   */
  visibleBranchIds?: Set<string> | string[] | null;
};

/**
 * Build the deduplicated, normalized custom-field payload for one expense.
 *
 * - Regular template values and conditional branch values are merged into a
 *   single list of rows so the RPC can replace the full set atomically.
 * - `0` and `false` are preserved.
 * - Empty / removed fields are excluded, so on edit they disappear after the
 *   atomic replace.
 * - Duplicate template/branch ids collapse to the last occurrence.
 */
export function buildExpenseCustomFieldPayload({
  templateValues,
  branchValues,
  visibleBranchIds,
}: BuildPayloadArgs): ExpenseCustomFieldValuePayload[] {
  const byTemplate = new Map<string, string>();
  const byBranch = new Map<string, string>();

  for (const [templateId, rawValue] of Object.entries(templateValues ?? {})) {
    if (!templateId) continue;
    if (!isFilledCustomFieldValue(rawValue)) continue;
    byTemplate.set(templateId, String(rawValue));
  }

  const visibleSet =
    visibleBranchIds == null
      ? null
      : visibleBranchIds instanceof Set
        ? visibleBranchIds
        : new Set(visibleBranchIds);

  for (const [branchId, rawValue] of Object.entries(branchValues ?? {})) {
    if (!branchId) continue;
    if (visibleSet && !visibleSet.has(branchId)) continue;
    if (!isFilledCustomFieldValue(rawValue)) continue;
    byBranch.set(branchId, String(rawValue));
  }

  const payload: ExpenseCustomFieldValuePayload[] = [];
  for (const [templateId, value] of byTemplate) {
    payload.push({ template_id: templateId, branch_field_id: null, field_value: value });
  }
  for (const [branchId, value] of byBranch) {
    payload.push({ template_id: null, branch_field_id: branchId, field_value: value });
  }

  return payload;
}
