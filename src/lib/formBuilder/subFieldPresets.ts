/**
 * Pure helpers for Reusable Sub-field Sets (DOC-062).
 *
 * A preset stores the *structure* of dependent fields (titles, keys, types,
 * settings, nesting) without binding to a specific parent option value or
 * submitting expense data.  Admins define a preset once and apply it across
 * any number of parent options.
 *
 * No side-effects, no imports from React or Supabase — fully unit-testable.
 */

import type { BranchFieldType } from "@/lib/conditionalFormFieldTypes";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";
import { slugifyFieldKey } from "@/lib/conditionalFormFields";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ReusableSubFieldDefinition = {
  /** Client-only stable id — survives clone/merge operations */
  localSchemaId: string;
  fieldKey: string;
  name: string;
  fieldType: BranchFieldType;
  required: boolean;
  placeholder: string;
  helpText: string;
  /** Default choices for select/checkbox fields — stored only when the preset
   *  was saved with "Include default choices" = true. Otherwise empty. */
  options: string[];
  displayOrder: number;
  children: ReusableSubFieldDefinition[];
};

export type ReusableSubFieldSet = {
  id: string;
  organizationId: string;
  parentTemplateId: string;
  name: string;
  description: string | null;
  fieldSchema: ReusableSubFieldDefinition[];
  isDefault: boolean;
  enforceOnAllParentOptions: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Lightweight summary shown in toolbars / selection lists */
export type PresetSummary = {
  id: string;
  name: string;
  fieldCount: number;
  isDefault: boolean;
  enforceOnAllParentOptions: boolean;
  updatedAt: string;
};

export type PresetLoadState = "idle" | "loading" | "success" | "error";

export type ApplyPresetMode =
  | "merge"       // add missing field_keys, keep existing
  | "sync"        // update name/type/required/order from preset, keep per-option choices
  | "replace";    // replace all root structure (requires confirmation)

export type PresetConflict = {
  fieldKey: string;
  presetName: string;
  draftName: string;
  conflictKind: "type_mismatch" | "key_collision" | "name_mismatch";
};

export type ApplyPresetResult = {
  drafts: DraftOptionBranch[];
  appliedTo: number;   // number of parent options that were modified
  skipped: number;     // already had the full structure
};

// ─── Field count ───────────────────────────────────────────────────────────────

export function countPresetFields(schema: ReusableSubFieldDefinition[]): number {
  return schema.reduce((acc, f) => acc + 1 + countPresetFields(f.children), 0);
}

// ─── Validation ────────────────────────────────────────────────────────────────

export type PresetSchemaError = {
  fieldKey: string;
  message: string;
};

export function validatePresetSchema(
  schema: ReusableSubFieldDefinition[],
  _depth = 0,
): PresetSchemaError[] {
  const errors: PresetSchemaError[] = [];
  const seenKeys = new Set<string>();

  for (const field of schema) {
    if (!field.name.trim()) {
      errors.push({ fieldKey: field.fieldKey || "(unnamed)", message: "Field name is required" });
    }
    if (!field.fieldKey.trim()) {
      errors.push({ fieldKey: field.name || "(no key)", message: "Field key is required" });
    }
    const lower = field.fieldKey.toLowerCase();
    if (seenKeys.has(lower)) {
      errors.push({ fieldKey: field.fieldKey, message: `Duplicate field key "${field.fieldKey}" in preset` });
    } else {
      seenKeys.add(lower);
    }
    if (field.children.length > 0) {
      errors.push(...validatePresetSchema(field.children, _depth + 1));
    }
  }
  return errors;
}

// ─── Normalize field keys ──────────────────────────────────────────────────────

export function normalizePresetFieldKeys(
  schema: ReusableSubFieldDefinition[],
): ReusableSubFieldDefinition[] {
  return schema.map((f) => ({
    ...f,
    fieldKey: f.fieldKey.trim() || slugifyFieldKey(f.name),
    children: normalizePresetFieldKeys(f.children),
  }));
}

// ─── Build preset from branches for one parent option ─────────────────────────

/**
 * Extract the structure of one parent option's branches as a reusable preset
 * schema.  Strips DB IDs, parent option values, and submitted expense data.
 *
 * @param rootDrafts     Root branches (parent_branch_local_id === null) for this option
 * @param allDrafts      Full draft array (needed to resolve nested children)
 * @param includeOptions When false (default), strips per-option dropdown choices
 */
export function buildPresetFromParentOption(
  rootDrafts: DraftOptionBranch[],
  allDrafts: DraftOptionBranch[],
  includeOptions = false,
): ReusableSubFieldDefinition[] {
  const sorted = [...rootDrafts].sort((a, b) => a.display_order - b.display_order);

  function buildNode(draft: DraftOptionBranch): ReusableSubFieldDefinition {
    const childDrafts = allDrafts
      .filter((d) => d.parent_branch_local_id === draft.localId)
      .sort((a, b) => a.display_order - b.display_order);

    return {
      localSchemaId: crypto.randomUUID(),
      fieldKey: draft.field_key.trim() || slugifyFieldKey(draft.name),
      name: draft.name,
      fieldType: draft.field_type as BranchFieldType,
      required: draft.required,
      placeholder: draft.placeholder ?? "",
      helpText: draft.help_text ?? "",
      options: includeOptions && (draft.field_type === "select" || draft.field_type === "checkbox")
        ? [...draft.options]
        : [],
      displayOrder: draft.display_order,
      children: childDrafts.map(buildNode),
    };
  }

  return sorted.filter((d) => d.name.trim()).map(buildNode);
}

// ─── Clone with new localIds ───────────────────────────────────────────────────

type ClonedNode = {
  definition: ReusableSubFieldDefinition;
  /** New localId assigned during clone */
  newLocalId: string;
};

function cloneSchemaNode(
  def: ReusableSubFieldDefinition,
  parentOptionValue: string,
  parentBranchLocalId: string | null,
  displayOrder: number,
  drafts: DraftOptionBranch[],
): void {
  const newLocalId = crypto.randomUUID();

  const draft: DraftOptionBranch = {
    localId: newLocalId,
    dbId: null,                                 // never a saved DB row
    parent_option_value: parentOptionValue,
    parent_branch_local_id: parentBranchLocalId,
    field_key: def.fieldKey,
    name: def.name,
    field_type: def.fieldType,
    required: def.required,
    placeholder: def.placeholder,
    help_text: def.helpText,
    options: [...def.options],
    display_order: displayOrder,
  };
  drafts.push(draft);

  def.children.forEach((child, idx) =>
    cloneSchemaNode(child, parentOptionValue, newLocalId, child.displayOrder ?? idx, drafts),
  );
}

/**
 * Clone a preset schema into a flat DraftOptionBranch[] for a specific
 * parent option value.  Every branch gets a new localId, dbId = null.
 */
export function clonePresetForParentOption(
  schema: ReusableSubFieldDefinition[],
  parentOptionValue: string,
): DraftOptionBranch[] {
  const drafts: DraftOptionBranch[] = [];
  const sorted = [...schema].sort((a, b) => a.displayOrder - b.displayOrder);
  sorted.forEach((def, idx) =>
    cloneSchemaNode(def, parentOptionValue, null, def.displayOrder ?? idx, drafts),
  );
  return drafts;
}

// ─── Apply modes ───────────────────────────────────────────────────────────────

/**
 * Merge: add branches whose field_key is missing.
 * Preserves all existing branches (including custom ones not in the preset).
 * Does NOT replace choices on existing select/checkbox branches.
 */
export function mergePresetIntoParentOption(
  existingDrafts: DraftOptionBranch[],
  schema: ReusableSubFieldDefinition[],
  parentOptionValue: string,
): DraftOptionBranch[] {
  const rootDrafts = existingDrafts.filter(
    (d) => d.parent_branch_local_id === null && d.parent_option_value === parentOptionValue,
  );
  const existingKeys = new Set(rootDrafts.map((d) => d.field_key.toLowerCase()));
  const nextDrafts = [...existingDrafts];

  const sorted = [...schema].sort((a, b) => a.displayOrder - b.displayOrder);
  sorted.forEach((def) => {
    if (!existingKeys.has(def.fieldKey.toLowerCase())) {
      const newBranches = clonePresetForParentOption([def], parentOptionValue);
      nextDrafts.push(...newBranches);
    }
  });

  return nextDrafts;
}

/**
 * Sync: update name / fieldType / required / displayOrder on existing root
 * branches whose field_key matches.  Preserves per-option dropdown choices.
 * Adds missing fields (same as merge for missing keys).
 */
export function syncPresetIntoParentOption(
  existingDrafts: DraftOptionBranch[],
  schema: ReusableSubFieldDefinition[],
  parentOptionValue: string,
): DraftOptionBranch[] {
  const sorted = [...schema].sort((a, b) => a.displayOrder - b.displayOrder);
  let nextDrafts = [...existingDrafts];
  const existingKeys = new Set(
    nextDrafts
      .filter((d) => d.parent_branch_local_id === null && d.parent_option_value === parentOptionValue)
      .map((d) => d.field_key.toLowerCase()),
  );

  nextDrafts = nextDrafts.map((d) => {
    if (d.parent_branch_local_id !== null) return d;
    if (d.parent_option_value !== parentOptionValue) return d;
    const match = sorted.find((s) => s.fieldKey.toLowerCase() === d.field_key.toLowerCase());
    if (!match) return d;
    return {
      ...d,
      name: match.name,
      field_type: match.fieldType,
      required: match.required,
      placeholder: match.placeholder,
      help_text: match.helpText,
      display_order: match.displayOrder,
      // Intentionally preserve d.options (per-option choices)
    };
  });

  // Add missing
  sorted.forEach((def) => {
    if (!existingKeys.has(def.fieldKey.toLowerCase())) {
      const newBranches = clonePresetForParentOption([def], parentOptionValue);
      nextDrafts.push(...newBranches);
    }
  });

  return nextDrafts;
}

/**
 * Replace: remove all root branches (and their descendants) for this option,
 * then clone the preset in.
 */
export function replaceParentOptionWithPreset(
  existingDrafts: DraftOptionBranch[],
  schema: ReusableSubFieldDefinition[],
  parentOptionValue: string,
): DraftOptionBranch[] {
  // Collect all localIds belonging to this option (BFS)
  const toRemove = new Set<string>();
  const rootsToRemove = existingDrafts.filter(
    (d) => d.parent_branch_local_id === null && d.parent_option_value === parentOptionValue,
  );

  function collectDescendants(localId: string) {
    toRemove.add(localId);
    existingDrafts
      .filter((d) => d.parent_branch_local_id === localId)
      .forEach((child) => collectDescendants(child.localId));
  }
  rootsToRemove.forEach((r) => collectDescendants(r.localId));

  const kept = existingDrafts.filter((d) => !toRemove.has(d.localId));
  const cloned = clonePresetForParentOption(schema, parentOptionValue);
  return [...kept, ...cloned];
}

// ─── Apply preset to multiple parent options ───────────────────────────────────

export function applyPresetToParentOptions(
  allDrafts: DraftOptionBranch[],
  schema: ReusableSubFieldDefinition[],
  targetOptions: string[],
  mode: ApplyPresetMode,
): ApplyPresetResult {
  let drafts = [...allDrafts];
  let appliedTo = 0;
  let skipped = 0;

  for (const opt of targetOptions) {
    const rootsBefore = drafts.filter(
      (d) => d.parent_branch_local_id === null && d.parent_option_value === opt,
    );
    const existingKeys = new Set(rootsBefore.map((d) => d.field_key.toLowerCase()));
    const allPresetKeys = schema.map((s) => s.fieldKey.toLowerCase());
    const alreadyComplete = allPresetKeys.every((k) => existingKeys.has(k));

    if (mode === "merge" && alreadyComplete) {
      skipped++;
      continue;
    }

    if (mode === "merge") {
      drafts = mergePresetIntoParentOption(drafts, schema, opt);
    } else if (mode === "sync") {
      drafts = syncPresetIntoParentOption(drafts, schema, opt);
    } else {
      drafts = replaceParentOptionWithPreset(drafts, schema, opt);
    }
    appliedTo++;
  }

  return { drafts, appliedTo, skipped };
}

// ─── Default preset: auto-apply to new options ─────────────────────────────────

/**
 * Returns the list of parent option values that have no root branches at all.
 */
export function getUnconfiguredOptions(
  allOptions: string[],
  allDrafts: DraftOptionBranch[],
): string[] {
  const configured = new Set(
    allDrafts
      .filter((d) => d.parent_branch_local_id === null && d.name.trim())
      .map((d) => d.parent_option_value),
  );
  return allOptions.filter((o) => !configured.has(o));
}

/**
 * Auto-apply a default preset to newly-added options.
 * Returns modified drafts and the list of options that received the preset.
 */
export function applyDefaultPresetToNewOptions(
  existingOptions: string[],
  newOptions: string[],
  allDrafts: DraftOptionBranch[],
  defaultPresetSchema: ReusableSubFieldDefinition[],
): { drafts: DraftOptionBranch[]; appliedOptions: string[] } {
  const genuinelyNew = newOptions.filter((o) => !existingOptions.includes(o));
  if (genuinelyNew.length === 0 || defaultPresetSchema.length === 0) {
    return { drafts: allDrafts, appliedOptions: [] };
  }

  const { drafts } = applyPresetToParentOptions(allDrafts, defaultPresetSchema, genuinelyNew, "merge");
  return { drafts, appliedOptions: genuinelyNew };
}

// ─── Conflict detection ────────────────────────────────────────────────────────

export function findPresetConflicts(
  existingDrafts: DraftOptionBranch[],
  schema: ReusableSubFieldDefinition[],
  parentOptionValue: string,
): PresetConflict[] {
  const conflicts: PresetConflict[] = [];
  const rootDrafts = existingDrafts.filter(
    (d) => d.parent_branch_local_id === null && d.parent_option_value === parentOptionValue,
  );

  for (const def of schema) {
    const matching = rootDrafts.filter(
      (d) => d.field_key.toLowerCase() === def.fieldKey.toLowerCase(),
    );
    for (const d of matching) {
      if (d.field_type !== def.fieldType) {
        conflicts.push({
          fieldKey: def.fieldKey,
          presetName: def.name,
          draftName: d.name,
          conflictKind: "type_mismatch",
        });
      } else if (d.name !== def.name) {
        conflicts.push({
          fieldKey: def.fieldKey,
          presetName: def.name,
          draftName: d.name,
          conflictKind: "name_mismatch",
        });
      }
    }
  }
  return conflicts;
}

// ─── Serialization helpers ─────────────────────────────────────────────────────

/** Convert a DB row (jsonb field_schema) to typed ReusableSubFieldDefinition[] */
export function deserializePresetSchema(raw: unknown): ReusableSubFieldDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: Record<string, unknown>) => ({
    localSchemaId: (item.local_schema_id as string | undefined) ?? crypto.randomUUID(),
    fieldKey: (item.field_key as string | undefined) ?? "",
    name: (item.name as string | undefined) ?? "",
    fieldType: (item.field_type as BranchFieldType | undefined) ?? "text",
    required: Boolean(item.required),
    placeholder: (item.placeholder as string | undefined) ?? "",
    helpText: (item.help_text as string | undefined) ?? "",
    options: Array.isArray(item.options) ? (item.options as string[]) : [],
    displayOrder: typeof item.display_order === "number" ? item.display_order : 0,
    children: deserializePresetSchema(item.children),
  }));
}

/** Convert typed definitions to the JSONB array stored in the DB */
export function serializePresetSchema(schema: ReusableSubFieldDefinition[]): object[] {
  return schema.map((f) => ({
    local_schema_id: f.localSchemaId,
    field_key: f.fieldKey,
    name: f.name,
    field_type: f.fieldType,
    required: f.required,
    placeholder: f.placeholder,
    help_text: f.helpText,
    options: f.options,
    display_order: f.displayOrder,
    children: serializePresetSchema(f.children),
  }));
}

// ─── Matrix helpers ────────────────────────────────────────────────────────────

export type MatrixCell = {
  parentOptionValue: string;
  fieldKey: string;
  draft: DraftOptionBranch | null;
  choiceCount: number;
  isComplete: boolean;
};

export type MatrixRow = {
  parentOptionValue: string;
  cells: MatrixCell[];
  isConfigured: boolean;
  isComplete: boolean;
};

/**
 * Build a matrix representation for the given options and root schema columns.
 * Each row is one parent option; each column is one preset field_key.
 */
export function buildPresetMatrix(
  parentOptions: string[],
  schemaColumns: ReusableSubFieldDefinition[],
  allDrafts: DraftOptionBranch[],
): MatrixRow[] {
  return parentOptions.map((opt) => {
    const rootDrafts = allDrafts.filter(
      (d) => d.parent_branch_local_id === null && d.parent_option_value === opt,
    );
    const cells: MatrixCell[] = schemaColumns.map((col) => {
      const draft =
        rootDrafts.find((d) => d.field_key.toLowerCase() === col.fieldKey.toLowerCase()) ?? null;
      const choiceCount =
        draft && (draft.field_type === "select" || draft.field_type === "checkbox")
          ? draft.options.filter((o) => o.trim()).length
          : 0;
      const isComplete =
        draft !== null &&
        draft.name.trim() !== "" &&
        (!col.required || (draft.field_type === "select" ? choiceCount > 0 : true));
      return { parentOptionValue: opt, fieldKey: col.fieldKey, draft, choiceCount, isComplete };
    });

    const isConfigured = rootDrafts.some((d) => d.name.trim());
    const isComplete = cells.every((c) => c.isComplete);
    return { parentOptionValue: opt, cells, isConfigured, isComplete };
  });
}

/**
 * Build matrix columns directly from whatever root dependent fields already
 * exist in the draft — no saved ReusableSubFieldSet required. One column per
 * distinct field_key across ALL parent options (the same "shared identity
 * across parents" model bulk import and the rest of this file already use),
 * using the first-seen root branch as that column's representative metadata.
 * Columns are ordered by their representative's display_order.
 *
 * This lets the matrix editor work immediately after a bulk import (which
 * produces branchDrafts but no preset), while a saved preset remains the
 * cleanest way to define/reuse a standard column set across templates.
 */
export function inferMatrixColumnsFromDrafts(
  allDrafts: DraftOptionBranch[],
): ReusableSubFieldDefinition[] {
  const byFieldKey = new Map<string, DraftOptionBranch>();
  for (const d of allDrafts) {
    if (d.parent_branch_local_id !== null) continue;
    if (!d.name.trim()) continue;
    const key = d.field_key.trim().toLowerCase();
    if (!key || byFieldKey.has(key)) continue;
    byFieldKey.set(key, d);
  }

  return Array.from(byFieldKey.values())
    .sort((a, b) => a.display_order - b.display_order)
    .map((d) => ({
      localSchemaId: d.localId,
      fieldKey: d.field_key,
      name: d.name,
      fieldType: d.field_type,
      required: d.required,
      placeholder: d.placeholder,
      helpText: d.help_text,
      options: [],
      displayOrder: d.display_order,
      children: [],
    }));
}

// ─── Layout types ─────────────────────────────────────────────────────────────

export type FieldLayoutContext = "review" | "detail";

export type FieldLayoutItem = {
  id: string;
  organizationId: string;
  context: FieldLayoutContext;
  parentTemplateId: string;
  /** 'template' | field_key | 'field_key>nested_key' */
  fieldPath: string;
  displayOrder: number;
  isVisible: boolean;
  displayStyle: "standard" | "compact" | "inline";
};

export type LayoutGroup = {
  parentTemplateId: string;
  parentTemplateName: string;
  displayOrder: number;
  items: FieldLayoutItem[];
};
