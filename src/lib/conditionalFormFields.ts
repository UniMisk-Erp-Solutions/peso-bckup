import {
  MAX_CONDITIONAL_BRANCH_DEPTH,
  type BranchFieldValueMap,
  type OptionBranchDefinition,
} from "@/lib/conditionalFormFieldTypes";

export function parseBranchOptions(options: unknown): string[] | null {
  if (!options) return null;
  if (Array.isArray(options)) {
    return options.map(String).filter((o) => o.trim().length > 0);
  }
  return null;
}

export function normalizeBranchRow(row: Record<string, unknown>): OptionBranchDefinition {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    parent_template_id: String(row.parent_template_id),
    parent_option_value: String(row.parent_option_value),
    parent_branch_id: row.parent_branch_id ? String(row.parent_branch_id) : null,
    field_key: String(row.field_key),
    name: String(row.name),
    field_type: row.field_type as OptionBranchDefinition["field_type"],
    required: Boolean(row.required),
    placeholder: (row.placeholder as string) ?? null,
    help_text: (row.help_text as string) ?? null,
    default_value: (row.default_value as string) ?? null,
    validation_rules: (row.validation_rules as Record<string, unknown>) ?? null,
    options: parseBranchOptions(row.options),
    display_order: Number(row.display_order ?? 0),
  };
}

/** Branches directly under a parent select template for a chosen option value. */
export function getRootBranchesForOption(
  branches: OptionBranchDefinition[],
  parentTemplateId: string,
  optionValue: string,
): OptionBranchDefinition[] {
  return branches
    .filter(
      (b) =>
        b.parent_template_id === parentTemplateId &&
        b.parent_branch_id === null &&
        b.parent_option_value === optionValue,
    )
    .sort((a, b) => a.display_order - b.display_order);
}

/** Branches under a nested select branch field for a chosen option value. */
export function getNestedBranchesForOption(
  branches: OptionBranchDefinition[],
  parentBranchId: string,
  optionValue: string,
): OptionBranchDefinition[] {
  return branches
    .filter((b) => b.parent_branch_id === parentBranchId && b.parent_option_value === optionValue)
    .sort((a, b) => a.display_order - b.display_order);
}

export interface VisibleBranch {
  branch: OptionBranchDefinition;
  depth: number;
}

/**
 * Compute all visible branch fields given template values (parent selects) and branch values (nested selects).
 */
export function getVisibleBranches(
  branches: OptionBranchDefinition[],
  templateValues: Record<string, string>,
  branchValues: BranchFieldValueMap,
  allowNested: boolean,
): VisibleBranch[] {
  const visible: VisibleBranch[] = [];
  const selectTemplateIds = new Set(
    branches.filter((b) => b.parent_branch_id === null).map((b) => b.parent_template_id),
  );

  function walkNested(parentBranchId: string, parentValue: string, depth: number) {
    if (!allowNested || depth >= MAX_CONDITIONAL_BRANCH_DEPTH) return;
    const children = getNestedBranchesForOption(branches, parentBranchId, parentValue);
    for (const child of children) {
      visible.push({ branch: child, depth });
      if (child.field_type === "select") {
        const childVal = branchValues[child.id];
        if (childVal) walkNested(child.id, childVal, depth + 1);
      }
    }
  }

  for (const templateId of selectTemplateIds) {
    const parentValue = templateValues[templateId];
    if (!parentValue) continue;
    const roots = getRootBranchesForOption(branches, templateId, parentValue);
    for (const root of roots) {
      visible.push({ branch: root, depth: 1 });
      if (root.field_type === "select" && allowNested) {
        const rootVal = branchValues[root.id];
        if (rootVal) walkNested(root.id, rootVal, 1);
      }
    }
  }

  return visible;
}

export function getVisibleBranchIds(
  branches: OptionBranchDefinition[],
  templateValues: Record<string, string>,
  branchValues: BranchFieldValueMap,
  allowNested: boolean,
): Set<string> {
  return new Set(
    getVisibleBranches(branches, templateValues, branchValues, allowNested).map((v) => v.branch.id),
  );
}

/** After a parent template or branch select changes, return branch ids whose values should be cleared. */
export function getBranchIdsToClear(
  branches: OptionBranchDefinition[],
  templateValues: Record<string, string>,
  branchValues: BranchFieldValueMap,
  allowNested: boolean,
  changedKey: { type: "template"; id: string } | { type: "branch"; id: string },
): string[] {
  const visible = getVisibleBranchIds(branches, templateValues, branchValues, allowNested);
  return Object.keys(branchValues).filter((id) => !visible.has(id));
}

export function buildInitialBranchValues(
  branches: OptionBranchDefinition[],
  templateValues: Record<string, string>,
  allowNested: boolean,
  existing: BranchFieldValueMap = {},
): BranchFieldValueMap {
  const visible = getVisibleBranches(branches, templateValues, existing, allowNested);
  const next: BranchFieldValueMap = {};
  for (const { branch } of visible) {
    if (existing[branch.id] !== undefined) {
      next[branch.id] = existing[branch.id];
    } else if (branch.default_value) {
      next[branch.id] = branch.default_value;
    } else if (branch.field_type === "checkbox") {
      next[branch.id] = "false";
    }
  }
  return next;
}

export function validateVisibleBranchFields(
  branches: OptionBranchDefinition[],
  templateValues: Record<string, string>,
  branchValues: BranchFieldValueMap,
  allowNested: boolean,
): { valid: boolean; missing: string[] } {
  const visible = getVisibleBranches(branches, templateValues, branchValues, allowNested);
  const missing: string[] = [];
  for (const { branch } of visible) {
    if (!branch.required) continue;
    const val = branchValues[branch.id];
    if (val === undefined || val === null || String(val).trim() === "") {
      missing.push(branch.name);
    }
  }
  return { valid: missing.length === 0, missing };
}

export function isBranchUnderTemplate(
  branch: OptionBranchDefinition,
  templateId: string,
  allBranches: OptionBranchDefinition[],
): boolean {
  if (!branch.parent_branch_id) {
    return branch.parent_template_id === templateId;
  }
  let parentId: string | null = branch.parent_branch_id;
  while (parentId) {
    const parent = allBranches.find((b) => b.id === parentId);
    if (!parent) return false;
    if (!parent.parent_branch_id) {
      return parent.parent_template_id === templateId;
    }
    parentId = parent.parent_branch_id;
  }
  return false;
}

export function slugifyFieldKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64) || "field";
}
