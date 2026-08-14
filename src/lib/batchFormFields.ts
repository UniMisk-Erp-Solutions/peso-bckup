import type { BatchLineInput } from "@/lib/expenseBatchValidation";

export type CategoryAssignmentRow = {
  ask_once_per_batch?: boolean | null;
  show_on_submit?: boolean | null;
  template?: { show_on_submit?: boolean | null; id?: string; name?: string };
  [key: string]: unknown;
};

export function isAssignmentVisibleOnSubmit(assignment: CategoryAssignmentRow): boolean {
  return (assignment.show_on_submit ?? assignment.template?.show_on_submit ?? true) === true;
}

export function splitAssignmentsByBatchMode(assignments: CategoryAssignmentRow[]) {
  const visible = assignments.filter(isAssignmentVisibleOnSubmit);
  const batchOnce = visible.filter((a) => a.ask_once_per_batch === true);
  const perLine = visible.filter((a) => a.ask_once_per_batch !== true);
  return { batchOnce, perLine };
}

/** Merge per-category batch-level values into each line before submit. */
export function applyBatchFieldsToLines(
  lines: BatchLineInput[],
  batchFieldsByCategory: Record<string, Record<string, string>>,
  batchBranchByCategory?: Record<string, Record<string, string>>,
): BatchLineInput[] {
  return lines.map((line) => {
    const cat = line.category?.trim() || "";
    const shared = batchFieldsByCategory[cat];
    const sharedBranch = batchBranchByCategory?.[cat];
    if (
      (!shared || Object.keys(shared).length === 0) &&
      (!sharedBranch || Object.keys(sharedBranch).length === 0)
    ) {
      return line;
    }
    return {
      ...line,
      formFieldValues: {
        ...(line.formFieldValues || {}),
        ...(shared || {}),
      },
      branchValues: {
        ...(line.branchValues || {}),
        ...(sharedBranch || {}),
      },
    };
  });
}

export function uniqueCategoriesInLines(lines: BatchLineInput[]): string[] {
  return [
    ...new Set(
      lines.map((l) => l.category?.trim()).filter((c): c is string => Boolean(c)),
    ),
  ];
}
