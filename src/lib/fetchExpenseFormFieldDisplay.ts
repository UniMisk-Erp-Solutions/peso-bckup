import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkArray } from "@/lib/supabaseInQuery";
import {
  classifySupabaseError,
  makeBranchFieldId,
  makeLegacyFieldId,
  makeTemplateFieldId,
  buildExpenseFieldDisplayGroups,
  type FieldDisplayResult,
  type FieldDisplayContext,
  type ExpenseDisplayFieldWithHierarchy,
  type ExpenseFormFieldDisplayNode,
} from "@/lib/expenseFieldDisplayModel";

export type ExpenseFormFieldDisplayRow = {
  id: string;
  /** Stable field identity: template:<uuid> | branch:<uuid> | legacy:<value_uuid>. Set for all rows built from DB metadata; absent for prefetch/map synthetic rows. */
  stableId?: string;
  name: string;
  field_type: string;
  field_value: string;
  display_order: number;
  /** DB id of the template row — set for template-sourced rows */
  templateId?: string | null;
  /** DB id of the branch row — set for branch-sourced rows */
  branchId?: string | null;
  /** parent_template_id from the branch row — links branch to its parent template */
  parentTemplateId?: string | null;
  /** parent_branch_id from the branch row — links nested branches */
  parentBranchId?: string | null;
  /** field_key from the branch or template row */
  fieldKey?: string | null;
};

export type FormFieldDisplayContext = "review" | "detail";

type TemplateMeta = {
  name: string;
  field_key: string | null;
  field_type: string;
  show_on_review?: boolean | null;
  show_on_detail?: boolean | null;
  display_order?: number | null;
};

type BranchMeta = {
  name: string;
  field_key: string | null;
  field_type: string;
  display_order: number;
  parent_template_id: string | null;
  parent_branch_id: string | null;
};

type RawValueRow = {
  id: string;
  template_id: string | null;
  branch_field_id?: string | null;
  field_value: string;
};

const GENERIC_FIELD_LABEL = "Field";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a string is shaped like a raw internal UUID (template_id, branch_field_id,
 * etc). Used ONLY to keep internal identifiers out of the LABEL position — never applied
 * to field VALUES, which may legitimately be a UUID a user typed in.
 *
 * Some upstream sources (e.g. get_debug_review_expense_detail_v1's field_key fallback to
 * t.id::text when a template/branch has no configured name or field_key) can hand us a raw
 * id where a human label is expected; this is the last line of defense against ever
 * rendering one.
 */
export function isUuidLikeLabel(value: string): boolean {
  return UUID_RE.test(value.trim());
}

function isGenericFieldLabel(name: string | null | undefined): boolean {
  const normalized = String(name ?? "").trim();
  return !normalized || normalized === GENERIC_FIELD_LABEL;
}

function humanizeFieldKey(fieldKey: string): string {
  const trimmed = fieldKey.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveFieldLabel(input: {
  name?: string | null;
  field_key?: string | null;
}): string {
  const name = String(input.name ?? "").trim();
  if (name && name !== GENERIC_FIELD_LABEL) return name;
  const key = String(input.field_key ?? "").trim();
  if (key) return humanizeFieldKey(key);
  return GENERIC_FIELD_LABEL;
}

function mapValueRows(
  data: Record<string, unknown>[],
  select: string,
): RawValueRow[] {
  const includesBranch = select.includes("branch_field_id");
  return data.map((row) => ({
    id: row.id as string,
    template_id: (row.template_id as string | null) ?? null,
    branch_field_id: includesBranch ? ((row.branch_field_id as string | null) ?? null) : null,
    field_value: String(row.field_value ?? ""),
  }));
}

async function resolveOrganizationIdForExpense(
  supabase: SupabaseClient,
  expenseId: string,
  organizationIdHint: string,
): Promise<string> {
  const hint = String(organizationIdHint ?? "").trim();
  if (hint) {
    const { data } = await supabase
      .from("expenses")
      .select("organization_id")
      .eq("id", expenseId)
      .eq("organization_id", hint)
      .maybeSingle();
    if (data?.organization_id) return String(data.organization_id);
  }

  const { data } = await supabase
    .from("expenses")
    .select("organization_id")
    .eq("id", expenseId)
    .maybeSingle();

  return data?.organization_id ? String(data.organization_id) : hint;
}

async function loadValueRows(
  supabase: SupabaseClient,
  expenseId: string,
  organizationId: string,
): Promise<RawValueRow[]> {
  const selectAttempts = [
    "id, template_id, branch_field_id, field_value",
    "id, template_id, field_value",
  ] as const;

  for (const select of selectAttempts) {
    let orgQueryErrored = false;

    const withOrg = await supabase
      .from("expense_form_field_values")
      .select(select)
      .eq("expense_id", expenseId)
      .eq("organization_id", organizationId);

    if (withOrg.error) {
      orgQueryErrored = true;
    } else if (withOrg.data?.length) {
      return mapValueRows(withOrg.data as Record<string, unknown>[], select);
    }

    const withoutOrg = await supabase
      .from("expense_form_field_values")
      .select(select)
      .eq("expense_id", expenseId);

    if (withoutOrg.error) {
      if (orgQueryErrored) continue;
      console.warn("fetchExpenseFormFieldDisplay values", withoutOrg.error);
      continue;
    }

    if (withoutOrg.data?.length) {
      return mapValueRows(withoutOrg.data as Record<string, unknown>[], select);
    }

    // Both queries succeeded with zero rows — expense has no saved custom fields.
    if (!orgQueryErrored) {
      return [];
    }
  }

  return [];
}

function mapTemplateRow(row: {
  id: string;
  name: string;
  field_key?: string | null;
  field_type?: string;
  show_on_review?: boolean | null;
  show_on_detail?: boolean | null;
  display_order?: number | null;
}): [string, TemplateMeta] {
  return [
    row.id,
    {
      name: row.name,
      field_key: row.field_key ?? null,
      field_type: row.field_type || "text",
      show_on_review: "show_on_review" in row ? row.show_on_review : true,
      show_on_detail: "show_on_detail" in row ? row.show_on_detail : true,
      display_order: row.display_order,
    },
  ];
}

/** PostgREST returns 400 when SELECT lists columns missing on prod (e.g. display_order on templates). */
async function queryTableBatchWithSelectFallback(
  supabase: SupabaseClient,
  table: "expense_form_field_templates" | "expense_form_field_option_branches",
  batch: string[],
  organizationId: string,
  selectAttempts: readonly string[],
): Promise<Record<string, unknown>[]> {
  let lastError: { message: string } | null = null;

  for (const select of selectAttempts) {
    for (const useOrg of [true, false] as const) {
      let query = supabase.from(table).select(select).in("id", batch);
      if (useOrg) {
        query = query.eq("organization_id", organizationId);
      }

      const { data, error } = await query;

      if (!error) {
        return (data || []) as Record<string, unknown>[];
      }

      lastError = error;
    }
  }

  if (lastError) {
    console.warn(`fetchExpenseFormFieldDisplay ${table}`, lastError);
  }

  return [];
}

const TEMPLATE_SELECT_ATTEMPTS = [
  "id, name, field_key, field_type, show_on_review, show_on_detail",
  "id, name, field_key, field_type",
  "id, name, field_type",
  "id, name",
] as const;

const BRANCH_SELECT_ATTEMPTS = [
  "id, name, field_key, field_type, display_order, parent_template_id, parent_branch_id",
  "id, name, field_key, field_type, display_order",
  "id, name, field_type, display_order",
  "id, name, field_type",
  "id, name",
] as const;

async function fetchCategoryDisplayOrders(
  supabase: SupabaseClient,
  templateIds: string[],
  organizationId: string,
): Promise<Map<string, number>> {
  const orderByTemplate = new Map<string, number>();
  if (templateIds.length === 0) return orderByTemplate;

  for (const batch of chunkArray(templateIds)) {
    const { data, error } = await supabase
      .from("expense_category_form_fields")
      .select("template_id, display_order")
      .eq("organization_id", organizationId)
      .in("template_id", batch);

    if (error || !data) continue;

    for (const row of data) {
      const templateId = row.template_id as string;
      const order = (row.display_order as number) ?? 0;
      const prev = orderByTemplate.get(templateId);
      if (prev === undefined || order < prev) {
        orderByTemplate.set(templateId, order);
      }
    }
  }

  return orderByTemplate;
}

async function fetchTemplateRowsByIds(
  supabase: SupabaseClient,
  templateIds: string[],
  organizationId: string,
): Promise<Map<string, TemplateMeta>> {
  const templateById = new Map<string, TemplateMeta>();
  if (templateIds.length === 0) return templateById;

  for (const batch of chunkArray(templateIds)) {
    const rows = await queryTableBatchWithSelectFallback(
      supabase,
      "expense_form_field_templates",
      batch,
      organizationId,
      TEMPLATE_SELECT_ATTEMPTS,
    );

    for (const row of rows) {
      const [id, meta] = mapTemplateRow(row as Parameters<typeof mapTemplateRow>[0]);
      templateById.set(id, meta);
    }
  }

  const displayOrders = await fetchCategoryDisplayOrders(
    supabase,
    templateIds,
    organizationId,
  );

  for (const [id, meta] of templateById) {
    const order = displayOrders.get(id);
    if (order !== undefined) {
      templateById.set(id, { ...meta, display_order: order });
    }
  }

  return templateById;
}

async function fetchBranchRowsByIds(
  supabase: SupabaseClient,
  branchIds: string[],
  organizationId: string,
): Promise<Map<string, BranchMeta>> {
  const branchById = new Map<string, BranchMeta>();
  if (branchIds.length === 0) return branchById;

  for (const batch of chunkArray(branchIds)) {
    const rows = await queryTableBatchWithSelectFallback(
      supabase,
      "expense_form_field_option_branches",
      batch,
      organizationId,
      BRANCH_SELECT_ATTEMPTS,
    );

    for (const row of rows) {
      const id = row.id as string;
      branchById.set(id, {
        name: String(row.name ?? ""),
        field_key: (row.field_key as string | null) ?? null,
        field_type: String(row.field_type ?? "text"),
        display_order: (row.display_order as number) ?? 0,
        parent_template_id: (row.parent_template_id as string | null) ?? null,
        parent_branch_id: (row.parent_branch_id as string | null) ?? null,
      });
    }
  }

  return branchById;
}

function labelFromValueRow(
  valueRow: RawValueRow,
  templateById: Map<string, TemplateMeta>,
  branchById: Map<string, BranchMeta>,
): string {
  if (valueRow.template_id) {
    const tpl = templateById.get(valueRow.template_id);
    if (tpl) return resolveFieldLabel(tpl);
  }
  if (valueRow.branch_field_id) {
    const branch = branchById.get(valueRow.branch_field_id);
    if (branch) return resolveFieldLabel(branch);
  }
  return GENERIC_FIELD_LABEL;
}

function buildDisplayRows(
  valueRows: RawValueRow[],
  templateById: Map<string, TemplateMeta>,
  branchById: Map<string, BranchMeta>,
  context?: FormFieldDisplayContext,
): ExpenseFormFieldDisplayRow[] {
  const rows: ExpenseFormFieldDisplayRow[] = [];

  for (const valueRow of valueRows) {
    const fieldValue = String(valueRow.field_value ?? "");

    if (valueRow.template_id) {
      const tpl = templateById.get(valueRow.template_id);

      // Apply context visibility filter when context is known and flags are explicitly false
      if (context && tpl) {
        if (context === "review" && tpl.show_on_review === false) continue;
        if (context === "detail" && tpl.show_on_detail === false) continue;
      }

      rows.push({
        id: valueRow.id,
        stableId: makeTemplateFieldId(valueRow.template_id),
        name: tpl ? resolveFieldLabel(tpl) : GENERIC_FIELD_LABEL,
        field_type: tpl?.field_type || "text",
        field_value: fieldValue,
        display_order: tpl?.display_order ?? 0,
        templateId: valueRow.template_id,
        fieldKey: tpl?.field_key ?? null,
      });
      continue;
    }

    if (valueRow.branch_field_id) {
      const branch = branchById.get(valueRow.branch_field_id);
      rows.push({
        id: valueRow.id,
        stableId: makeBranchFieldId(valueRow.branch_field_id),
        name: branch ? resolveFieldLabel(branch) : GENERIC_FIELD_LABEL,
        field_type: branch?.field_type || "text",
        field_value: fieldValue,
        display_order: branch?.display_order ?? 1000,
        branchId: valueRow.branch_field_id,
        parentTemplateId: branch?.parent_template_id ?? null,
        parentBranchId: branch?.parent_branch_id ?? null,
        fieldKey: branch?.field_key ?? null,
      });
      continue;
    }

    rows.push({
      id: valueRow.id,
      stableId: makeLegacyFieldId(valueRow.id),
      name: GENERIC_FIELD_LABEL,
      field_type: "text",
      field_value: fieldValue,
      display_order: 9999,
    });
  }

  return sortDisplayRows(rows);
}

function sortDisplayRows(
  rows: ExpenseFormFieldDisplayRow[],
): ExpenseFormFieldDisplayRow[] {
  return [...rows].sort(
    (a, b) =>
      a.display_order - b.display_order ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase();
}

function applyFieldMapToRows(
  rows: ExpenseFormFieldDisplayRow[],
  fieldMap: Record<string, string> | undefined,
): ExpenseFormFieldDisplayRow[] {
  if (!fieldMap || Object.keys(fieldMap).length === 0) return rows;

  const valueByName = new Map<string, string>();
  for (const [name, rawValue] of Object.entries(fieldMap)) {
    const value = String(rawValue ?? "").trim();
    if (!value) continue;
    valueByName.set(normalizeFieldName(name), value);
  }

  if (valueByName.size === 0) return rows;

  const seenNames = new Set<string>();
  const merged = rows.map((row) => {
    const key = normalizeFieldName(row.name);
    seenNames.add(key);
    const mapped = valueByName.get(key);
    if (mapped && !String(row.field_value ?? "").trim()) {
      return { ...row, field_value: mapped };
    }
    return row;
  });

  for (const [nameKey, value] of valueByName) {
    if (seenNames.has(nameKey)) continue;
    const originalName =
      Object.keys(fieldMap).find((k) => normalizeFieldName(k) === nameKey) ?? nameKey;
    merged.push({
      id: `map:${originalName}`,
      name: originalName,
      field_type: "text",
      field_value: value,
      display_order: 9000 + merged.length,
    });
  }

  return sortDisplayRows(merged);
}

/**
 * Deduplicates rows using a stable identity key.
 *
 * Priority: stableId (template/<uuid> | branch/<uuid> | legacy/<uuid>) is
 * used when present — two rows with the same stableId are the same field and
 * their values are merged (non-empty value wins, lower display_order wins).
 *
 * For synthetic rows (prefetch:* / map:*) that have no stableId, we fall back
 * to a normalized display-name key — same behaviour as before but only for
 * rows that genuinely have no stable identity.
 */
function mergeDisplayRowsByName(
  rows: ExpenseFormFieldDisplayRow[],
): ExpenseFormFieldDisplayRow[] {
  const byKey = new Map<string, ExpenseFormFieldDisplayRow>();

  for (const row of rows) {
    // Prefer stableId; fall back to normalized name for synthetic rows
    const key = row.stableId ?? normalizeFieldName(row.name);
    if (!key) continue;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }

    const field_value = String(row.field_value ?? "").trim()
      ? row.field_value
      : prev.field_value;
    const name = !isGenericFieldLabel(row.name)
      ? row.name
      : !isGenericFieldLabel(prev.name)
        ? prev.name
        : row.name;

    const preferredId = prev.id.startsWith("category:") || prev.id.startsWith("prefetch:")
      ? row.id
      : prev.id;

    byKey.set(key, {
      id: preferredId,
      stableId: row.stableId ?? prev.stableId,
      name,
      field_type: row.field_type || prev.field_type || "text",
      field_value,
      display_order: Math.min(prev.display_order, row.display_order),
    });
  }

  return sortDisplayRows([...byKey.values()]);
}

function rowsWithValuesOnly(
  rows: ExpenseFormFieldDisplayRow[],
): ExpenseFormFieldDisplayRow[] {
  return rows.filter((row) => String(row.field_value ?? "").trim() !== "");
}

// Builds a name→value map from already-loaded template/branch data + optional inline prefetch.
// Replaces the old resolveFieldValueMap which called fetchExpenseCustomFieldsMap (3 extra DB
// round-trips for form_field_values + templates + branches that were fetched again anyway).
function buildFieldMapFromLoadedData(
  valueRows: RawValueRow[],
  templateById: Map<string, TemplateMeta>,
  branchById: Map<string, BranchMeta>,
  inline?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const valueRow of valueRows) {
    const fieldValue = String(valueRow.field_value ?? "").trim();
    if (!fieldValue) continue;

    let name = "";
    if (valueRow.template_id) {
      const tpl = templateById.get(valueRow.template_id);
      if (tpl) name = resolveFieldLabel(tpl);
    }
    if (!name && valueRow.branch_field_id) {
      const branch = branchById.get(valueRow.branch_field_id);
      if (branch) name = resolveFieldLabel(branch);
    }
    if (!name) continue;
    merged[name] = fieldValue;
  }

  if (inline) {
    for (const [name, value] of Object.entries(inline)) {
      if (isUuidLikeLabel(name)) {
        console.warn("fetchExpenseFormFieldDisplay: dropped unresolved internal id used as label", { name });
        continue;
      }
      const trimmed = String(value ?? "").trim();
      if (trimmed) merged[name] = trimmed;
    }
  }

  return merged;
}

function mergeDisplayRows(
  clientRows: ExpenseFormFieldDisplayRow[],
  rpcRows: ExpenseFormFieldDisplayRow[],
): ExpenseFormFieldDisplayRow[] {
  const merged = new Map<string, ExpenseFormFieldDisplayRow>();

  for (const row of rpcRows) {
    merged.set(row.id, row);
  }

  for (const row of clientRows) {
    const prev = merged.get(row.id);
    if (!prev) {
      merged.set(row.id, row);
      continue;
    }

    const name = !isGenericFieldLabel(row.name)
      ? row.name
      : !isGenericFieldLabel(prev.name)
        ? prev.name
        : row.name;

    // Preserve stableId/templateId/branchId (whichever side has them — RPC rows from
    // mapRpcDisplayRows never carry stableId, client rows from buildDisplayRows always do)
    // so later dedup-by-identity in mergeDisplayRowsByName doesn't fall back to
    // name-matching for a row that already has a real stable identity.
    merged.set(row.id, {
      id: row.id,
      stableId: row.stableId ?? prev.stableId,
      name,
      field_type: row.field_type || prev.field_type || "text",
      field_value: row.field_value || prev.field_value,
      display_order: row.display_order ?? prev.display_order ?? 0,
      templateId: row.templateId ?? prev.templateId,
      branchId: row.branchId ?? prev.branchId,
      parentTemplateId: row.parentTemplateId ?? prev.parentTemplateId,
      parentBranchId: row.parentBranchId ?? prev.parentBranchId,
      fieldKey: row.fieldKey ?? prev.fieldKey,
    });
  }

  return sortDisplayRows([...merged.values()]);
}

function enrichRowsWithMeta(
  rows: ExpenseFormFieldDisplayRow[],
  valueRows: RawValueRow[],
  templateById: Map<string, TemplateMeta>,
  branchById: Map<string, BranchMeta>,
): ExpenseFormFieldDisplayRow[] {
  const valueById = new Map(valueRows.map((row) => [row.id, row]));

  return rows.map((row) => {
    if (!isGenericFieldLabel(row.name)) return row;
    const raw = valueById.get(row.id);
    if (!raw) return row;
    const label = labelFromValueRow(raw, templateById, branchById);
    if (isGenericFieldLabel(label)) return row;
    return { ...row, name: label };
  });
}

function rowsFromPrefetchedFields(
  fields: Record<string, string> | undefined,
): ExpenseFormFieldDisplayRow[] {
  if (!fields) return [];
  return sortDisplayRows(
    Object.entries(fields)
      .filter(([name, value]) => {
        if (isUuidLikeLabel(name)) {
          console.warn("fetchExpenseFormFieldDisplay: dropped unresolved internal id used as label", { name });
          return false;
        }
        return value !== null && value !== undefined && String(value).trim() !== "";
      })
      .map(([name, field_value], index) => ({
        id: `prefetch:${name}`,
        name,
        field_type: "text",
        field_value: String(field_value),
        display_order: index,
      })),
  );
}

async function loadExpenseCategoryName(
  supabase: SupabaseClient,
  expenseId: string,
  organizationId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("expenses")
    .select("category")
    .eq("id", expenseId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!error && data?.category) {
    return String(data.category).trim() || null;
  }

  const { data: fallback } = await supabase
    .from("expenses")
    .select("category")
    .eq("id", expenseId)
    .maybeSingle();

  return fallback?.category ? String(fallback.category).trim() : null;
}

type CategoryAssignment = {
  template_id: string;
  display_order: number;
};

async function loadCategoryTemplateAssignments(
  supabase: SupabaseClient,
  organizationId: string,
  categoryName: string,
): Promise<CategoryAssignment[]> {
  const { data: category, error: categoryError } = await supabase
    .from("expense_categories")
    .select("id")
    .eq("organization_id", organizationId)
    .ilike("name", categoryName)
    .maybeSingle();

  if (categoryError || !category?.id) {
    return [];
  }

  const { data: assignments, error } = await supabase
    .from("expense_category_form_fields")
    .select("template_id, display_order")
    .eq("organization_id", organizationId)
    .eq("category_id", category.id)
    .order("display_order", { ascending: true });

  if (error || !assignments?.length) {
    return [];
  }

  return assignments.map((row) => ({
    template_id: row.template_id as string,
    display_order: (row.display_order as number) ?? 0,
  }));
}

function buildRowsFromCategoryAssignments(
  assignments: CategoryAssignment[],
  templateById: Map<string, TemplateMeta>,
  valueRows: RawValueRow[],
  branchById: Map<string, BranchMeta>,
): ExpenseFormFieldDisplayRow[] {
  const valueByTemplate = new Map<string, RawValueRow>();
  for (const row of valueRows) {
    if (row.template_id) valueByTemplate.set(row.template_id, row);
  }

  const rows: ExpenseFormFieldDisplayRow[] = [];

  for (const assignment of assignments) {
    const tpl = templateById.get(assignment.template_id);
    const saved = valueByTemplate.get(assignment.template_id);
    rows.push({
      id: saved?.id ?? `category:${assignment.template_id}`,
      name: tpl ? resolveFieldLabel(tpl) : GENERIC_FIELD_LABEL,
      field_type: tpl?.field_type || "text",
      field_value: saved ? String(saved.field_value ?? "") : "",
      display_order: assignment.display_order ?? tpl?.display_order ?? 0,
    });
  }

  for (const valueRow of valueRows) {
    if (valueRow.branch_field_id) {
      const branch = branchById.get(valueRow.branch_field_id);
      rows.push({
        id: valueRow.id,
        name: branch ? resolveFieldLabel(branch) : GENERIC_FIELD_LABEL,
        field_type: branch?.field_type || "text",
        field_value: String(valueRow.field_value ?? ""),
        display_order: branch?.display_order ?? 1000,
      });
      continue;
    }

    if (
      valueRow.template_id &&
      !assignments.some((a) => a.template_id === valueRow.template_id)
    ) {
      const tpl = templateById.get(valueRow.template_id);
      rows.push({
        id: valueRow.id,
        name: tpl ? resolveFieldLabel(tpl) : GENERIC_FIELD_LABEL,
        field_type: tpl?.field_type || "text",
        field_value: String(valueRow.field_value ?? ""),
        display_order: tpl?.display_order ?? 500,
      });
    }
  }

  return sortDisplayRows(rows);
}

async function fetchCategoryFallbackRows(
  supabase: SupabaseClient,
  expenseId: string,
  organizationId: string,
  valueRows: RawValueRow[],
  branchById: Map<string, BranchMeta>,
  fieldMap: Record<string, string>,
  // Already-loaded templates from the main fetch — avoids a redundant DB round-trip for IDs
  // that were already fetched via fetchTemplateRowsByIds in fetchExpenseFormFieldDisplay.
  templateByIdHint?: Map<string, TemplateMeta>,
): Promise<ExpenseFormFieldDisplayRow[]> {
  const categoryName = await loadExpenseCategoryName(supabase, expenseId, organizationId);
  if (!categoryName) return [];

  const assignments = await loadCategoryTemplateAssignments(
    supabase,
    organizationId,
    categoryName,
  );
  if (assignments.length === 0) return [];

  const templateIds = assignments.map((a) => a.template_id);
  let templateById: Map<string, TemplateMeta>;
  if (templateByIdHint) {
    const missingIds = templateIds.filter((id) => !templateByIdHint.has(id));
    if (missingIds.length > 0) {
      const extra = await fetchTemplateRowsByIds(supabase, missingIds, organizationId);
      templateById = new Map([...templateByIdHint, ...extra]);
    } else {
      templateById = templateByIdHint;
    }
  } else {
    templateById = await fetchTemplateRowsByIds(supabase, templateIds, organizationId);
  }

  const rows = applyFieldMapToRows(
    buildRowsFromCategoryAssignments(
      assignments,
      templateById,
      valueRows,
      branchById,
    ),
    fieldMap,
  );

  return rowsWithValuesOnly(rows);
}

function mapRpcDisplayRows(data: unknown): ExpenseFormFieldDisplayRow[] {
  return ((data as unknown[]) || []).map(
    (row: {
      id: string;
      name: string;
      field_type: string;
      field_value: string;
      display_order: number;
    }) => ({
      id: row.id,
      name: String(row.name ?? "").trim() || GENERIC_FIELD_LABEL,
      field_type: row.field_type || "text",
      field_value: String(row.field_value ?? ""),
      display_order: row.display_order ?? 0,
    }),
  );
}

async function fetchViaRpc(
  supabase: SupabaseClient,
  expenseId: string,
  organizationId: string,
): Promise<ExpenseFormFieldDisplayRow[]> {
  const contexts = ["all", "review", "detail"] as const;

  for (const p_context of contexts) {
    const { data, error } = await supabase.rpc("get_expense_form_field_display", {
      p_organization_id: organizationId,
      p_expense_id: expenseId,
      p_context,
    });

    if (!error && data?.length) {
      return mapRpcDisplayRows(data);
    }

    if (error && !/function|schema cache|does not exist/i.test(error.message)) {
      console.warn("get_expense_form_field_display", { p_context, error });
    }
  }

  return [];
}

export type FetchExpenseFormFieldDisplayOptions = {
  /** Already-loaded name→value map (e.g. AdminPanel list enrichment). */
  prefetchedFields?: Record<string, string>;
};

/**
 * Load saved custom form field values for an expense without PostgREST embeds.
 */
export async function fetchExpenseFormFieldDisplay(
  supabase: SupabaseClient,
  expenseId: string,
  organizationId: string,
  context: FormFieldDisplayContext,
  options?: FetchExpenseFormFieldDisplayOptions,
): Promise<ExpenseFormFieldDisplayRow[]> {
  const orgId = await resolveOrganizationIdForExpense(supabase, expenseId, organizationId);
  if (!orgId) return [];

  // Fetch values + RPC in parallel first — fieldMap is now built from the loaded data
  // (eliminates the old resolveFieldValueMap → fetchExpenseCustomFieldsMap path which
  // fired 3 redundant DB queries: form_field_values + templates + branches all fetched
  // again below anyway).
  const [valueRows, rpcRows] = await Promise.all([
    loadValueRows(supabase, expenseId, orgId),
    fetchViaRpc(supabase, expenseId, orgId),
  ]);

  const templateIds = [
    ...new Set(valueRows.map((r) => r.template_id).filter(Boolean)),
  ] as string[];
  const branchIds = [
    ...new Set(valueRows.map((r) => r.branch_field_id).filter(Boolean)),
  ] as string[];

  const [templateById, branchById] = await Promise.all([
    fetchTemplateRowsByIds(supabase, templateIds, orgId),
    fetchBranchRowsByIds(supabase, branchIds, orgId),
  ]);

  const fieldMap = buildFieldMapFromLoadedData(valueRows, templateById, branchById, options?.prefetchedFields);
  const prefetchedRows = rowsFromPrefetchedFields(fieldMap);

  const clientRows =
    valueRows.length > 0
      ? enrichRowsWithMeta(
          // Pass context so show_on_review / show_on_detail flags are applied
          buildDisplayRows(valueRows, templateById, branchById, context),
          valueRows,
          templateById,
          branchById,
        )
      : [];

  const rpcEnriched =
    rpcRows.length > 0
      ? enrichRowsWithMeta(rpcRows, valueRows, templateById, branchById)
      : [];

  let result = mergeDisplayRows(clientRows, rpcEnriched);

  if (prefetchedRows.length > 0) {
    // rowsFromPrefetchedFields synthesizes one row per fieldMap entry — which already
    // includes every already-known valueRows-derived field, not just genuinely-extra
    // prefetched ones. Synthetic rows never carry a stableId, so a name-only collision
    // check here (rather than relying on mergeDisplayRowsByName's stableId-first dedup
    // key, which a real row with a stableId would never match against) is what actually
    // keeps an already-represented field from being merged in a second time.
    const existingNames = new Set(result.map((row) => normalizeFieldName(row.name)));
    const genuinelyNewPrefetchedRows = prefetchedRows.filter(
      (row) => !existingNames.has(normalizeFieldName(row.name)),
    );
    result = mergeDisplayRows(result, genuinelyNewPrefetchedRows);
  }

  result = applyFieldMapToRows(result, fieldMap);
  result = mergeDisplayRowsByName(result);

  const hasValues = result.some((row) => String(row.field_value ?? "").trim() !== "");
  if (!hasValues) {
    const categoryRows = await fetchCategoryFallbackRows(
      supabase,
      expenseId,
      orgId,
      valueRows,
      branchById,
      fieldMap,
      templateById,
    );
    result = mergeDisplayRowsByName(mergeDisplayRows(result, categoryRows));
    result = applyFieldMapToRows(result, fieldMap);
  }

  return rowsWithValuesOnly(mergeDisplayRowsByName(result));
}

/**
 * Same as fetchExpenseFormFieldDisplay but returns a structured result instead
 * of throwing. Callers that need error/retry UI should use this variant.
 */
export async function fetchExpenseFormFieldDisplaySafe(
  supabase: SupabaseClient,
  expenseId: string,
  organizationId: string,
  context: FieldDisplayContext,
  options?: FetchExpenseFormFieldDisplayOptions,
): Promise<FieldDisplayResult> {
  try {
    const fields = await fetchExpenseFormFieldDisplay(
      supabase,
      expenseId,
      organizationId,
      // FieldDisplayContext "all" maps to "review" for the underlying resolver
      // (review is the more permissive context — shows both review and detail fields)
      context === "all" ? "review" : context,
      options,
    );
    return { ok: true, fields: fields.map((row) => rowToDisplayField(row)) };
  } catch (err) {
    const supaErr = err && typeof err === "object" && "message" in err
      ? (err as { message?: string; code?: string })
      : null;
    return { ok: false, error: classifySupabaseError(supaErr) };
  }
}

function rowToDisplayField(row: ExpenseFormFieldDisplayRow): ExpenseDisplayFieldWithHierarchy {
  return {
    stableId: (row.stableId ?? `legacy:${row.id}`) as import("@/lib/expenseFieldDisplayModel").ExpenseFieldId,
    label: row.name,
    value: row.field_value,
    fieldType: row.field_type,
    displayOrder: row.display_order,
    source: row.stableId
      ? row.stableId.startsWith("template:") ? "template"
        : row.stableId.startsWith("branch:") ? "branch"
        : "legacy"
      : "legacy",
    visibility: { show_on_review: true, show_on_detail: true, show_on_submit: true },
    templateId: row.templateId ?? null,
    branchId: row.branchId ?? null,
    parentTemplateId: row.parentTemplateId ?? null,
    parentBranchId: row.parentBranchId ?? null,
    fieldKey: row.fieldKey ?? null,
    depth: row.parentBranchId ? 1 : row.parentTemplateId ? 0 : undefined,
    groupStableId: row.parentTemplateId
      ? makeTemplateFieldId(row.parentTemplateId)
      : null,
  };
}

/**
 * Fetch expense form field display data and return as an ordered list of
 * display nodes (standalone fields or grouped parent + branch children).
 * This is the preferred entry point for Phase 4 grouped display rendering.
 */
export async function fetchExpenseFormFieldDisplayGrouped(
  supabase: SupabaseClient,
  expenseId: string,
  organizationId: string,
  context: FieldDisplayContext,
  options?: FetchExpenseFormFieldDisplayOptions,
): Promise<{ ok: true; nodes: ExpenseFormFieldDisplayNode[] } | { ok: false; error: import("@/lib/expenseFieldDisplayModel").FieldDisplayError }> {
  const result = await fetchExpenseFormFieldDisplaySafe(supabase, expenseId, organizationId, context, options);
  if (!result.ok) return result;
  return {
    ok: true,
    nodes: buildExpenseFieldDisplayGroups(result.fields as ExpenseDisplayFieldWithHierarchy[]),
  };
}
