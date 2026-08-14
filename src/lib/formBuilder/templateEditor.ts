/**
 * Pure helpers for the scalable FormFieldTemplateEditorDialog.
 * No side-effects, no imports from React or Supabase — fully testable.
 */

import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";

// ─── Pagination ────────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function paginateItems<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.max(1, Math.min(page, pageCount(total, pageSize)));
}

// ─── Search ────────────────────────────────────────────────────────────────────

export function matchesSearch(value: string, term: string): boolean {
  if (!term.trim()) return true;
  return value.toLowerCase().includes(term.toLowerCase());
}

// ─── Indexed options ───────────────────────────────────────────────────────────

export type IndexedOption = {
  value: string;
  originalIndex: number;
};

/** Returns options with their original array index, filtered by search term. */
export function buildIndexedOptions(
  options: string[],
  searchTerm: string,
): IndexedOption[] {
  return options
    .map((value, originalIndex) => ({ value, originalIndex }))
    .filter(({ value }) => matchesSearch(value, searchTerm));
}

// ─── Branch indexing ───────────────────────────────────────────────────────────

export type BranchIndexes = {
  /** Root branches (no parent_branch_local_id) keyed by parent_option_value */
  rootsByParentOption: Map<string, DraftOptionBranch[]>;
  /** Children keyed by parent_branch_local_id */
  childrenByParentLocalId: Map<string, DraftOptionBranch[]>;
  /** Total branch count (root + nested) per parent_option_value */
  branchCountByParentOption: Map<string, number>;
};

export function buildBranchIndexes(drafts: DraftOptionBranch[]): BranchIndexes {
  const rootsByParentOption = new Map<string, DraftOptionBranch[]>();
  const childrenByParentLocalId = new Map<string, DraftOptionBranch[]>();
  const rootCountByOption = new Map<string, number>();
  const localIdToOption = new Map<string, string>();

  // First pass: collect all localId → option_value mappings
  for (const d of drafts) {
    localIdToOption.set(d.localId, d.parent_option_value);
  }

  // Second pass: categorize into roots and children
  for (const d of drafts) {
    if (!d.parent_branch_local_id) {
      const key = d.parent_option_value;
      if (!rootsByParentOption.has(key)) rootsByParentOption.set(key, []);
      rootsByParentOption.get(key)!.push(d);
      rootCountByOption.set(key, (rootCountByOption.get(key) ?? 0) + 1);
    } else {
      const key = d.parent_branch_local_id;
      if (!childrenByParentLocalId.has(key)) childrenByParentLocalId.set(key, []);
      childrenByParentLocalId.get(key)!.push(d);
    }
  }

  // Third pass: count all descendants (BFS) per option
  const branchCountByParentOption = new Map<string, number>();
  for (const [optValue, roots] of rootsByParentOption) {
    let count = roots.length;
    const queue = [...roots.map((r) => r.localId)];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = childrenByParentLocalId.get(parentId) ?? [];
      count += children.length;
      queue.push(...children.map((c) => c.localId));
    }
    branchCountByParentOption.set(optValue, count);
  }

  return { rootsByParentOption, childrenByParentLocalId, branchCountByParentOption };
}

// ─── Option validation ─────────────────────────────────────────────────────────

export type OptionIssue = {
  originalIndex: number;
  value: string;
  kind: "blank" | "duplicate";
};

export function validateOptions(options: string[]): OptionIssue[] {
  const issues: OptionIssue[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < options.length; i++) {
    const trimmed = options[i].trim();
    if (!trimmed) {
      issues.push({ originalIndex: i, value: options[i], kind: "blank" });
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) {
      issues.push({ originalIndex: i, value: trimmed, kind: "duplicate" });
    } else {
      seen.set(lower, i);
    }
  }

  return issues;
}

// ─── Option rename ─────────────────────────────────────────────────────────────

/**
 * Renames a parent option and migrates root branch drafts that reference it.
 * Nested branches are NOT touched (their parent_option_value is the sub-option
 * of a branch field, not the parent dropdown option).
 */
export function renameParentOption(
  options: string[],
  branchDrafts: DraftOptionBranch[],
  originalIndex: number,
  nextValue: string,
): { options: string[]; branchDrafts: DraftOptionBranch[] } {
  const oldValue = options[originalIndex];
  if (oldValue === nextValue) return { options, branchDrafts };

  const newOptions = options.map((v, i) => (i === originalIndex ? nextValue : v));
  const newDrafts = branchDrafts.map((d) => {
    // Only rename root branches (parent_branch_local_id === null) for the old option
    if (d.parent_branch_local_id === null && d.parent_option_value === oldValue) {
      return { ...d, parent_option_value: nextValue };
    }
    return d;
  });

  return { options: newOptions, branchDrafts: newDrafts };
}

// ─── Option delete ─────────────────────────────────────────────────────────────

/** Recursively collects local IDs of a branch and all its descendants. */
function collectDescendantIds(
  rootLocalId: string,
  drafts: DraftOptionBranch[],
): Set<string> {
  const toRemove = new Set<string>([rootLocalId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of drafts) {
      if (
        d.parent_branch_local_id &&
        toRemove.has(d.parent_branch_local_id) &&
        !toRemove.has(d.localId)
      ) {
        toRemove.add(d.localId);
        changed = true;
      }
    }
  }
  return toRemove;
}

/**
 * Deletes a parent option and removes any root branch drafts (and their
 * descendants) that are tied to it.
 */
export function deleteParentOption(
  options: string[],
  branchDrafts: DraftOptionBranch[],
  originalIndex: number,
): { options: string[]; branchDrafts: DraftOptionBranch[] } {
  const removedValue = options[originalIndex];
  const newOptions = options.filter((_, i) => i !== originalIndex);

  // Collect all IDs to remove
  const toRemove = new Set<string>();
  for (const d of branchDrafts) {
    if (d.parent_branch_local_id === null && d.parent_option_value === removedValue) {
      for (const id of collectDescendantIds(d.localId, branchDrafts)) {
        toRemove.add(id);
      }
    }
  }

  const newDrafts = branchDrafts.filter((d) => !toRemove.has(d.localId));
  return { options: newOptions, branchDrafts: newDrafts };
}

/** How many branch drafts would be removed if this option is deleted. */
export function countBranchesForOption(
  optionValue: string,
  branchDrafts: DraftOptionBranch[],
): number {
  const toRemove = new Set<string>();
  for (const d of branchDrafts) {
    if (d.parent_branch_local_id === null && d.parent_option_value === optionValue) {
      for (const id of collectDescendantIds(d.localId, branchDrafts)) {
        toRemove.add(id);
      }
    }
  }
  return toRemove.size;
}

// ─── Template validation ───────────────────────────────────────────────────────

export type ValidationIssue = {
  severity: "error" | "warning";
  message: string;
  section: "basics" | "options" | "dependent";
  optionIndex?: number;
};

export function validateTemplate({
  name,
  type,
  options,
  branchDrafts,
}: {
  name: string;
  type: string;
  options: string[];
  branchDrafts: DraftOptionBranch[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!name.trim()) {
    issues.push({ severity: "error", message: "Field name is required", section: "basics" });
  }

  if (type === "select" || type === "checkbox") {
    const cleanedOptions = options.map((o) => o.trim()).filter(Boolean);
    if (cleanedOptions.length === 0) {
      issues.push({
        severity: "error",
        message: "At least one option is required for dropdown/checkbox fields",
        section: "options",
      });
    }

    const optIssues = validateOptions(options);
    for (const oi of optIssues) {
      issues.push({
        severity: "error",
        message:
          oi.kind === "blank"
            ? `Option ${oi.originalIndex + 1} is blank`
            : `Duplicate option: "${oi.value}"`,
        section: "options",
        optionIndex: oi.originalIndex,
      });
    }

    // Named branch drafts with select/checkbox type need options
    for (const d of branchDrafts) {
      if (!d.name.trim()) continue; // unnamed drafts are filtered before save
      if (
        (d.field_type === "select" || d.field_type === "checkbox") &&
        d.options.filter((o) => o.trim()).length === 0
      ) {
        issues.push({
          severity: "error",
          message: `Dependent field "${d.name}" has no choices`,
          section: "dependent",
        });
      }
    }
  }

  return issues;
}

// ─── Save payload ──────────────────────────────────────────────────────────────

export function buildCleanedOptions(options: string[]): string[] {
  return options.reduce<string[]>((acc, option) => {
    const normalized = option.trim();
    if (!normalized) return acc;
    if (acc.some((ex) => ex.toLowerCase() === normalized.toLowerCase())) return acc;
    acc.push(normalized);
    return acc;
  }, []);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildTemplateData(params: {
  organizationId: string;
  name: string;
  type: string;
  required: boolean;
  placeholder: string;
  helpText: string;
  defaultValue: string;
  min: string;
  max: string;
  cleanedOptions: string[];
  userId: string | null;
  /** Template-level batch entry mode (null = per_line / legacy default) */
  batchEntryMode?: "once_per_batch" | "per_line" | null;
}) {
  const {
    organizationId, name, type, required, placeholder,
    helpText, defaultValue, min, max, cleanedOptions, userId,
    batchEntryMode,
  } = params;

  const validationRules: Record<string, number> = {};
  if (type === "number") {
    if (min) validationRules.min = parseFloat(min);
    if (max) validationRules.max = parseFloat(max);
  }

  return {
    organization_id: organizationId,
    name: name.trim(),
    field_type: type,
    required,
    placeholder: placeholder || null,
    help_text: helpText || null,
    default_value: defaultValue || null,
    validation_rules: Object.keys(validationRules).length > 0 ? validationRules : null,
    options: type === "select" || type === "checkbox" ? cleanedOptions : null,
    created_by: userId ?? null,
    batch_entry_mode: batchEntryMode ?? null,
  };
}

// ─── Dirty state snapshot ──────────────────────────────────────────────────────

export type TemplateEditorSnapshot = {
  name: string;
  type: string;
  required: boolean;
  placeholder: string;
  defaultValue: string;
  helpText: string;
  min: string;
  max: string;
  options: string[];
  branchDrafts: DraftOptionBranch[];
  batchEntryMode: "once_per_batch" | "per_line" | null;
};

export function makeSnapshot(s: TemplateEditorSnapshot): string {
  return JSON.stringify(s);
}

export function isSnapshotDirty(current: TemplateEditorSnapshot, baseline: string): boolean {
  return makeSnapshot(current) !== baseline;
}

// ─── Bulk options parsing ──────────────────────────────────────────────────────

export function parseBulkOptionValues(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function mergeBulkOptions(
  existing: string[],
  incoming: string[],
): { next: string[]; added: number; skipped: number } {
  const existingSet = new Set(existing.map((o) => o.toLowerCase()));
  const toAdd: string[] = [];
  let skipped = 0;

  for (const val of incoming) {
    const trimmed = val.trim();
    if (!trimmed) { skipped++; continue; }
    if (existingSet.has(trimmed.toLowerCase())) { skipped++; continue; }
    toAdd.push(trimmed);
    existingSet.add(trimmed.toLowerCase());
  }

  return { next: [...existing, ...toAdd], added: toAdd.length, skipped };
}
