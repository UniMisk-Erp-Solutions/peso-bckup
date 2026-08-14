/**
 * Canonical type model for expense field display.
 *
 * Identity model:
 *   base:<field_key>       — one of the 6 org-configurable base fields
 *   template:<uuid>        — custom field defined on an expense_form_field_templates row
 *   branch:<uuid>          — conditional/nested branch field
 *   legacy:<value_row_uuid>— saved value with no surviving template or branch (orphan)
 *
 * This file is pure types + small pure helpers — no Supabase, no React, no i18n.
 */

// ─── Base field keys ─────────────────────────────────────────────────────────

export type BaseExpenseFieldKey =
  | "category"
  | "title"
  | "destination"
  | "expense_date"
  | "purpose"
  | "amount";

export const BASE_EXPENSE_FIELD_KEYS: readonly BaseExpenseFieldKey[] = [
  "category",
  "title",
  "destination",
  "expense_date",
  "purpose",
  "amount",
];

// ─── Stable field identity ────────────────────────────────────────────────────

export type BaseFieldId = `base:${BaseExpenseFieldKey}`;
export type TemplateFieldId = `template:${string}`;
export type BranchFieldId = `branch:${string}`;
export type LegacyFieldId = `legacy:${string}`;

export type ExpenseFieldId =
  | BaseFieldId
  | TemplateFieldId
  | BranchFieldId
  | LegacyFieldId;

export function makeBaseFieldId(key: BaseExpenseFieldKey): BaseFieldId {
  return `base:${key}`;
}
export function makeTemplateFieldId(uuid: string): TemplateFieldId {
  return `template:${uuid}`;
}
export function makeBranchFieldId(uuid: string): BranchFieldId {
  return `branch:${uuid}`;
}
export function makeLegacyFieldId(valueRowUuid: string): LegacyFieldId {
  return `legacy:${valueRowUuid}`;
}

export function isBaseFieldId(id: string): id is BaseFieldId {
  return id.startsWith("base:");
}
export function isTemplateFieldId(id: string): id is TemplateFieldId {
  return id.startsWith("template:");
}
export function isBranchFieldId(id: string): id is BranchFieldId {
  return id.startsWith("branch:");
}
export function isLegacyFieldId(id: string): id is LegacyFieldId {
  return id.startsWith("legacy:");
}

export function extractBaseKey(id: BaseFieldId): BaseExpenseFieldKey {
  return id.slice("base:".length) as BaseExpenseFieldKey;
}
export function extractTemplateUuid(id: TemplateFieldId): string {
  return id.slice("template:".length);
}
export function extractBranchUuid(id: BranchFieldId): string {
  return id.slice("branch:".length);
}
export function extractLegacyUuid(id: LegacyFieldId): string {
  return id.slice("legacy:".length);
}

// ─── Field source classification ──────────────────────────────────────────────

export type ExpenseFieldSource = "base" | "template" | "branch" | "legacy";

export function classifyFieldId(id: string): ExpenseFieldSource {
  if (isBaseFieldId(id)) return "base";
  if (isTemplateFieldId(id)) return "template";
  if (isBranchFieldId(id)) return "branch";
  return "legacy";
}

// ─── Display context ──────────────────────────────────────────────────────────

export type FieldDisplayContext = "review" | "detail" | "all";

// ─── Visibility flags (from organization_expense_form_fields or template meta) ─

export interface FieldVisibilityFlags {
  /** Whether to show in review panels (EngineerReview, AdminPanel review dialog) */
  show_on_review: boolean;
  /** Whether to show in detail / read-only views (ExpenseDetail, AccountantApprovedExpenses) */
  show_on_detail: boolean;
  /** Whether to show on submission form */
  show_on_submit: boolean;
}

export function defaultVisibilityFlags(): FieldVisibilityFlags {
  return { show_on_review: true, show_on_detail: true, show_on_submit: true };
}

export function isVisibleInContext(
  flags: FieldVisibilityFlags,
  context: FieldDisplayContext,
): boolean {
  if (context === "all") return true;
  if (context === "review") return flags.show_on_review;
  if (context === "detail") return flags.show_on_detail;
  return true;
}

// ─── Canonical display field ──────────────────────────────────────────────────

/**
 * One row in the final display list for an expense's custom / base fields.
 *
 * `stableId` is the deterministic identity key — never a raw value-row UUID
 * unless no template or branch link survives (legacy). Use it instead of `name`
 * for dedup, mapping, and prefetch lookups.
 */
export interface ExpenseDisplayField {
  /** Stable field identity — see identity model at top of file. */
  stableId: ExpenseFieldId;
  /** Human-readable label (org-overridden or i18n-resolved). */
  label: string;
  /** Saved value as stored in expense_form_field_values.field_value */
  value: string;
  /** DB field type: text | number | date | select | multiselect | checkbox | file */
  fieldType: string;
  /** Sort position (lower = earlier). */
  displayOrder: number;
  /** Source classification for rendering hints. */
  source: ExpenseFieldSource;
  /** Visibility flags — use isVisibleInContext() to filter before rendering. */
  visibility: FieldVisibilityFlags;
}

// ─── Base field config (from organization_expense_form_fields) ────────────────

/**
 * Configuration for one base field as stored/resolved from the DB.
 * Mirrors the BaseFieldConfig in expenseFormConfig.ts — kept in sync manually.
 */
export interface BaseFieldConfig {
  label: string;
  is_visible: boolean;
  is_required: boolean;
  display_order: number;
  show_on_submit: boolean;
  show_on_review: boolean;
  show_on_detail: boolean;
  input_type?: string | null;
  options?: string[] | null;
}

/** All 6 base fields with their resolved configs. */
export type ResolvedBaseFieldConfig = Record<BaseExpenseFieldKey, BaseFieldConfig>;

// ─── Error types for structured error returns ─────────────────────────────────

export type FieldDisplayErrorCode =
  | "NOT_FOUND"        // expense or org not found
  | "PERMISSION"       // RLS denied access
  | "NETWORK"          // transient network/timeout
  | "UNKNOWN";         // unexpected error

export interface FieldDisplayError {
  code: FieldDisplayErrorCode;
  message: string;
  /** Whether a retry is likely to help */
  retryable: boolean;
}

export function classifySupabaseError(error: { message?: string; code?: string } | null): FieldDisplayError {
  if (!error) {
    return { code: "UNKNOWN", message: "Unknown error", retryable: false };
  }
  const msg = error.message ?? "";
  const code = error.code ?? "";

  if (/PGRST116|not found|no rows/i.test(msg) || code === "PGRST116") {
    return { code: "NOT_FOUND", message: msg, retryable: false };
  }
  if (/permission|policy|RLS|42501|JWT/i.test(msg)) {
    return { code: "PERMISSION", message: msg, retryable: false };
  }
  if (/network|timeout|fetch|ECONNREFUSED|socket/i.test(msg)) {
    return { code: "NETWORK", message: msg, retryable: true };
  }
  return { code: "UNKNOWN", message: msg, retryable: true };
}

// ─── Fetch result ─────────────────────────────────────────────────────────────

export type FieldDisplayResult =
  | { ok: true; fields: ExpenseDisplayField[] }
  | { ok: false; error: FieldDisplayError };

// ─── Hierarchy extensions (Phase 4 — grouped display) ─────────────────────────

/**
 * Extended row type returned from the DB fetch when hierarchy is requested.
 * These fields are optional so the existing flat path never breaks.
 */
export interface ExpenseDisplayFieldWithHierarchy extends ExpenseDisplayField {
  /** DB id of the parent template row (null for base / template-level fields) */
  templateId?: string | null;
  /** DB id of the option-branch row (null for base / template fields) */
  branchId?: string | null;
  /** parent_template_id from the branch — links a branch to its parent template */
  parentTemplateId?: string | null;
  /** parent_branch_id from the branch — links a nested branch to its parent */
  parentBranchId?: string | null;
  /** Stable field_key on the branch row */
  fieldKey?: string | null;
  /** Nesting depth: 0 = root, 1 = direct child branch, 2 = grandchild branch */
  depth?: number;
  /**
   * Dot-path using field_key segments — stable across rename, used for layout config.
   * e.g. "project_id" (root branch) or "project_id>site_name" (child branch)
   */
  fieldPath?: string | null;
  /**
   * Stable group id — same as the parent template's stableId for all branches
   * belonging to that template.  Used to key grouped display containers.
   */
  groupStableId?: string | null;
}

/**
 * A parent-template group: the template field itself plus all of its branch
 * sub-fields, ordered hierarchically.
 */
export interface ExpenseFieldDisplayGroup {
  /** stableId of the parent template field (e.g. "template:<uuid>") */
  groupStableId: string;
  /** Display label of the parent template field */
  groupLabel: string;
  /** Display value selected for this template field (e.g. "Project Unique ID: 202606M250") */
  groupValue: string;
  /** Sort position — the template field's displayOrder */
  displayOrder: number;
  /** Ordered list of branch sub-fields within this group */
  children: ExpenseDisplayFieldWithHierarchy[];
}

/**
 * One node in the flat-or-grouped display tree.
 * Independent fields (base + any template without branches) are standalone nodes.
 * Template fields that have submitted branches produce a group node instead.
 */
export type ExpenseFormFieldDisplayNode =
  | { kind: "field"; field: ExpenseDisplayFieldWithHierarchy }
  | { kind: "group"; group: ExpenseFieldDisplayGroup };

/**
 * Build an ordered list of display nodes from a flat array of extended fields.
 *
 * Algorithm:
 * 1. Collect all "template" source fields — each may have children (branches
 *    whose parentTemplateId === this template's DB id).
 * 2. For each template field that has at least one branch child, emit a group node.
 * 3. All other fields (base, legacy, template without branches) emit standalone nodes.
 * 4. Sort the final list by displayOrder ASC.
 *
 * Branch children inside a group are sorted by their own displayOrder then name.
 */
export function buildExpenseFieldDisplayGroups(
  fields: ExpenseDisplayFieldWithHierarchy[],
): ExpenseFormFieldDisplayNode[] {
  // Separate branches from non-branches
  const branchFields = fields.filter((f) => f.source === "branch" && f.parentTemplateId);
  const nonBranchFields = fields.filter((f) => f.source !== "branch" || !f.parentTemplateId);

  // Index branches by their parentTemplateId
  const branchesByTemplateId = new Map<string, ExpenseDisplayFieldWithHierarchy[]>();
  for (const b of branchFields) {
    const key = b.parentTemplateId!;
    const existing = branchesByTemplateId.get(key);
    if (existing) {
      existing.push(b);
    } else {
      branchesByTemplateId.set(key, [b]);
    }
  }

  const nodes: ExpenseFormFieldDisplayNode[] = [];

  for (const field of nonBranchFields) {
    // Check if this template field has branch children
    const templateUuid =
      field.source === "template" && field.templateId ? field.templateId : null;

    const children = templateUuid ? branchesByTemplateId.get(templateUuid) : undefined;

    if (children && children.length > 0) {
      // Sort children by depth ASC then displayOrder ASC then name
      const sortedChildren = [...children].sort((a, b) => {
        const depthDiff = (a.depth ?? 0) - (b.depth ?? 0);
        if (depthDiff !== 0) return depthDiff;
        const orderDiff = a.displayOrder - b.displayOrder;
        if (orderDiff !== 0) return orderDiff;
        return a.label.localeCompare(b.label);
      });

      nodes.push({
        kind: "group",
        group: {
          groupStableId: field.stableId,
          groupLabel: field.label,
          groupValue: field.value,
          displayOrder: field.displayOrder,
          children: sortedChildren,
        },
      });
    } else {
      nodes.push({ kind: "field", field });
    }
  }

  // Sort nodes by displayOrder
  nodes.sort((a, b) => {
    const aOrder = a.kind === "field" ? a.field.displayOrder : a.group.displayOrder;
    const bOrder = b.kind === "field" ? b.field.displayOrder : b.group.displayOrder;
    return aOrder - bOrder;
  });

  return nodes;
}
