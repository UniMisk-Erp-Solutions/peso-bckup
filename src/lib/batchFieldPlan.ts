/**
 * Pure model for template-level "once per batch" field deduplication.
 *
 * Key invariants:
 * - Template identity key is the template ID, NOT the category name.
 * - The same template assigned to multiple categories is asked only ONCE.
 * - Per-line fields remain per-line regardless of template settings.
 * - Conditional child fields inherit the root template's batch_entry_mode.
 * - Legacy `ask_once_per_batch === true` on an assignment with no `batch_entry_mode`
 *   on the template is treated as `batch_entry_mode = "once_per_batch"` (fallback).
 */

export type BatchEntryMode = "once_per_batch" | "per_line";

/**
 * Minimum shape we need from a form field assignment + its template.
 * Compatible with both old (`ask_once_per_batch`) and new (`batch_entry_mode`) schemas.
 */
export type BatchFieldAssignment = {
  id: string;
  /** The category this assignment belongs to */
  category_id: string;
  /** Category name (for display grouping) */
  category_name?: string | null;
  display_order?: number | null;
  show_on_submit?: boolean | null;
  /** Assignment-level required override (nullable). Resolved against template.required. */
  required?: boolean | null;
  /** Legacy column — present on old assignments */
  ask_once_per_batch?: boolean | null;
  template: {
    id: string;
    name?: string | null;
    field_type?: string | null;
    /** Real column name in expense_form_field_templates (not is_required). */
    required?: boolean | null;
    placeholder?: string | null;
    help_text?: string | null;
    options?: string[] | null;
    show_on_submit?: boolean | null;
    /** Added by migration 20260716120000. Supersedes ask_once_per_batch. */
    batch_entry_mode?: BatchEntryMode | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** One shared field in the batch field plan — represents a deduped template. */
export type SharedBatchField = {
  templateId: string;
  /** Canonical assignment (first category alphabetically for stable ordering) */
  assignment: BatchFieldAssignment;
  /** All category IDs that use this template in "once per batch" mode */
  categoryIds: string[];
  /** Category names for display label */
  categoryNames: string[];
};

/** Per-line field — one per assignment (category-specific) */
export type PerLineBatchField = {
  assignment: BatchFieldAssignment;
  categoryId: string;
  categoryName: string | null;
};

/** Central snapshot: one fetch, deduped by template ID */
export type BatchFieldPlan = {
  /** Shared fields — asked once, applied to all matching categories in the batch */
  shared: SharedBatchField[];
  /** Per-line fields — shown inline on each expense line */
  perLine: PerLineBatchField[];
};

/**
 * Resolve the effective batch entry mode for an assignment.
 * New: use `template.batch_entry_mode` if set.
 * Legacy fallback: use `ask_once_per_batch` on the assignment.
 */
export function resolveAssignmentBatchMode(
  assignment: BatchFieldAssignment,
): BatchEntryMode {
  const templateMode = assignment.template?.batch_entry_mode;
  if (templateMode === "once_per_batch" || templateMode === "per_line") {
    return templateMode;
  }
  // Legacy fallback
  if (assignment.ask_once_per_batch === true) {
    return "once_per_batch";
  }
  return "per_line";
}

/** Return true when the assignment should be shown at all (visibility check) */
export function isAssignmentVisible(assignment: BatchFieldAssignment): boolean {
  return (
    (assignment.show_on_submit ?? assignment.template?.show_on_submit ?? true) === true
  );
}

/**
 * Build the BatchFieldPlan from a flat list of category assignments.
 * Input: all assignments for all categories present in the current batch.
 * Pure — no I/O. Safe to call in useMemo.
 */
export function buildBatchFieldPlan(
  assignments: BatchFieldAssignment[],
  /** Only include assignments whose category_id is in this set */
  activeCategoryIds: Set<string>,
): BatchFieldPlan {
  const visible = assignments.filter(
    (a) => isAssignmentVisible(a) && activeCategoryIds.has(a.category_id),
  );

  const sharedMap = new Map<string, SharedBatchField>();
  const perLine: PerLineBatchField[] = [];

  for (const assignment of visible) {
    const mode = resolveAssignmentBatchMode(assignment);

    if (mode === "once_per_batch") {
      const templateId = assignment.template.id;
      const existing = sharedMap.get(templateId);
      if (existing) {
        // Merge: add this category to the existing shared field
        if (!existing.categoryIds.includes(assignment.category_id)) {
          existing.categoryIds.push(assignment.category_id);
          if (assignment.category_name) {
            existing.categoryNames.push(assignment.category_name);
          }
        }
      } else {
        sharedMap.set(templateId, {
          templateId,
          assignment,
          categoryIds: [assignment.category_id],
          categoryNames: assignment.category_name ? [assignment.category_name] : [],
        });
      }
    } else {
      perLine.push({
        assignment,
        categoryId: assignment.category_id,
        categoryName: assignment.category_name ?? null,
      });
    }
  }

  return {
    shared: [...sharedMap.values()],
    perLine,
  };
}

/**
 * Merge template-keyed shared field values into each batch line before submit.
 * replaces the old category-keyed `applyBatchFieldsToLines`.
 */
export function applyBatchFieldPlanToLines<
  TLine extends {
    category?: string | null;
    formFieldValues?: Record<string, string>;
    branchValues?: Record<string, string>;
  },
>(
  lines: TLine[],
  plan: BatchFieldPlan,
  /** template ID → { fieldValues, branchValues } collected from the shared UI */
  sharedValues: Record<string, { fields: Record<string, string>; branches: Record<string, string> }>,
  /** category ID → category name mapping for lookups */
  categoryNameById: Record<string, string>,
  /** category name → category ID mapping */
  categoryIdByName: Record<string, string>,
): TLine[] {
  return lines.map((line) => {
    const catName = line.category?.trim() ?? "";
    const catId = categoryIdByName[catName];
    if (!catId) return line;

    // Find all shared fields that apply to this line's category
    const applicableShared = plan.shared.filter((sf) => sf.categoryIds.includes(catId));

    let mergedFields: Record<string, string> = { ...(line.formFieldValues ?? {}) };
    let mergedBranches: Record<string, string> = { ...(line.branchValues ?? {}) };

    for (const sf of applicableShared) {
      const vals = sharedValues[sf.templateId];
      if (vals) {
        mergedFields = { ...mergedFields, ...vals.fields };
        mergedBranches = { ...mergedBranches, ...vals.branches };
      }
    }

    return {
      ...line,
      formFieldValues: mergedFields,
      branchValues: mergedBranches,
    };
  });
}

/**
 * Return the per-line assignments for a specific category from the plan.
 *
 * A template classified as once_per_batch will NEVER appear here — the plan
 * already separated it into plan.shared during buildBatchFieldPlan.
 */
export function getPerLineAssignmentsForCategory(
  plan: BatchFieldPlan,
  categoryId: string,
): BatchFieldAssignment[] {
  return plan.perLine
    .filter((plf) => plf.categoryId === categoryId)
    .map((plf) => plf.assignment);
}

/**
 * Return the template IDs of all "select" type per-line fields for a category.
 * Used to pre-fetch branch definitions without a per-line query.
 */
export function getPerLineSelectTemplateIds(
  plan: BatchFieldPlan,
  categoryId: string,
): string[] {
  return plan.perLine
    .filter(
      (plf) =>
        plf.categoryId === categoryId &&
        plf.assignment.template?.field_type === "select",
    )
    .map((plf) => plf.assignment.template.id);
}

/**
 * Get the set of active category IDs from a list of batch lines.
 * Uses a category name → ID mapping.
 */
export function getActiveCategoryIds(
  lines: Array<{ category?: string | null }>,
  categoryIdByName: Record<string, string>,
): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    const name = line.category?.trim();
    if (name) {
      const id = categoryIdByName[name];
      if (id) ids.add(id);
    }
  }
  return ids;
}
