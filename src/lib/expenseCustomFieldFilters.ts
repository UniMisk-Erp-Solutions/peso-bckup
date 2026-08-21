import { supabase } from "@/integrations/supabase/client";
import { chunkArray, SUPABASE_IN_QUERY_CHUNK_SIZE } from "@/lib/supabaseInQuery";

/** Max expense IDs per DB query for custom-field value fetches. */
export const CUSTOM_FIELD_BATCH_SIZE = 25;
/** Max simultaneous DB queries when fetching custom-field values. */
export const MAX_CUSTOM_FIELD_CONCURRENCY = 3;

/**
 * Run an array of async tasks with bounded concurrency.
 * Tasks that throw are caught — their slot is freed and results array gets `undefined`.
 */
async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrency: number,
  signal?: AbortSignal,
): Promise<(T | undefined)[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      if (signal?.aborted) break;
      const idx = nextIndex++;
      if (idx >= tasks.length) break;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        console.warn("[runWithConcurrencyLimit] task error:", err);
        results[idx] = undefined;
      }
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, tasks.length) }, runWorker);
  await Promise.all(workers);
  return results;
}

export const CUSTOM_FIELD_FILTER_ALL = "all";

export type FilterableCustomField = {
  /** Field display name (matches keys on expense.custom_fields). */
  key: string;
  label: string;
  fieldType: "select" | "checkbox";
  choices: { value: string; label: string }[];
};

function chunkIds<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function parseFieldOptions(options: unknown): string[] {
  if (options == null) return [];
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => {
      if (typeof o === "string") return o.trim();
      if (o && typeof o === "object") {
        const row = o as { value?: unknown; label?: unknown };
        if (row.value != null && String(row.value).trim()) return String(row.value).trim();
        if (row.label != null && String(row.label).trim()) return String(row.label).trim();
      }
      return String(o ?? "").trim();
    })
    .filter(Boolean);
}

export function buildInitialCustomFieldFilters(
  fields: FilterableCustomField[],
): Record<string, string> {
  const init: Record<string, string> = {};
  for (const field of fields) init[field.key] = CUSTOM_FIELD_FILTER_ALL;
  return init;
}

export function matchesCustomFieldFilters(
  customFields: Record<string, string> | undefined,
  filters: Record<string, string>,
): boolean {
  for (const [key, filterVal] of Object.entries(filters)) {
    if (!filterVal || filterVal === CUSTOM_FIELD_FILTER_ALL) continue;
    const actual = String(customFields?.[key] ?? "").trim();
    if (actual !== filterVal) return false;
  }
  return true;
}

export function filterExpensesByCustomFields<T extends { custom_fields?: Record<string, string> }>(
  expenses: T[],
  filters: Record<string, string>,
): T[] {
  return expenses.filter((expense) =>
    matchesCustomFieldFilters(expense.custom_fields, filters),
  );
}

function upsertFilterableField(
  map: Map<string, FilterableCustomField>,
  name: string,
  fieldType: "select" | "checkbox",
  options: unknown,
  extraValues: string[] = [],
) {
  const label = String(name || "").trim();
  if (!label) return;

  const templateChoices =
    fieldType === "checkbox"
      ? [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ]
      : parseFieldOptions(options).map((o) => ({ value: o, label: o }));

  const choiceMap = new Map<string, { value: string; label: string }>();
  for (const choice of templateChoices) choiceMap.set(choice.value, choice);
  for (const raw of extraValues) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (!choiceMap.has(value)) choiceMap.set(value, { value, label: value });
  }

  const existing = map.get(label);
  if (existing) {
    for (const choice of existing.choices) choiceMap.set(choice.value, choice);
    map.set(label, {
      ...existing,
      fieldType: existing.fieldType === "checkbox" ? "checkbox" : fieldType,
      choices: [...choiceMap.values()],
    });
    return;
  }

  map.set(label, {
    key: label,
    label,
    fieldType,
    choices: [...choiceMap.values()],
  });
}

/** Merge org field definitions with values this employee actually has on expenses. */
export function mergeFilterableFieldsWithEmployeeData(
  orgFields: FilterableCustomField[],
  filledByField: Record<string, Set<string>> | Record<string, string[]>,
): FilterableCustomField[] {
  const map = new Map<string, FilterableCustomField>();
  for (const field of orgFields) map.set(field.key, { ...field });

  for (const [key, rawValues] of Object.entries(filledByField)) {
    const values = rawValues instanceof Set ? [...rawValues] : rawValues;
    if (!key || values.length === 0) continue;
    const existing = map.get(key);
    if (existing) {
      upsertFilterableField(map, key, existing.fieldType, null, values);
    } else {
      upsertFilterableField(map, key, "select", null, values);
    }
  }

  return [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

/**
 * DOC-100 pt.3: PostgREST silently caps a single unpaged `.select()` at its
 * default row limit (the exact failure mode this whole hotfix exists to
 * close — see the RPC-name-truncation and Parent-Options-search fixes
 * earlier in this branch). Loop with `.range()` until a page comes back
 * short, same auto-paged full-scan pattern this file already uses for
 * `scanExpenseValues` below, instead of trusting one request to return
 * everything.
 */
async function fetchAllPages<T>(
  fetchPage: (offset: number, pageSize: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  context: string,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await fetchPage(offset, pageSize);
    if (error) {
      console.warn(context, error);
      break;
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

export async function fetchFilterableCustomFieldDefinitions(
  organizationId: string,
): Promise<FilterableCustomField[]> {
  const map = new Map<string, FilterableCustomField>();

  const templates = await fetchAllPages<{ name: string; field_type: string; options: unknown }>(
    (offset, pageSize) =>
      supabase
        .from("expense_form_field_templates")
        .select("id, name, field_type, options")
        .eq("organization_id", organizationId)
        .in("field_type", ["select", "checkbox"])
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1),
    "expense_form_field_templates (filters)",
  );
  for (const row of templates) {
    if (row.field_type === "select" || row.field_type === "checkbox") {
      upsertFilterableField(map, row.name, row.field_type, row.options);
    }
  }

  const assignments = await fetchAllPages<{
    expense_form_field_templates: { name?: string; field_type?: string; options?: unknown } | null;
  }>(
    (offset, pageSize) =>
      supabase
        .from("expense_category_form_fields")
        .select("id, expense_form_field_templates(name, field_type, options)")
        .eq("organization_id", organizationId)
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1),
    "expense_category_form_fields (filters)",
  );
  for (const row of assignments) {
    const tpl = row.expense_form_field_templates;
    if (!tpl?.name) continue;
    if (tpl.field_type === "select" || tpl.field_type === "checkbox") {
      upsertFilterableField(map, tpl.name, tpl.field_type, tpl.options);
    }
  }

  const branches = await fetchAllPages<{ name: string; field_type: string; options: unknown }>(
    (offset, pageSize) =>
      supabase
        .from("expense_form_field_option_branches")
        .select("id, name, field_type, options")
        .eq("organization_id", organizationId)
        .in("field_type", ["select", "checkbox"])
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1),
    "expense_form_field_option_branches (filters)",
  );
  for (const row of branches) {
    if (row.field_type === "select" || row.field_type === "checkbox") {
      upsertFilterableField(map, row.name, row.field_type, row.options);
    }
  }

  return [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

export type FetchFilterableCustomFieldsOptions = {
  /** Scan all expense_form_field_values (slow; can timeout on large orgs). */
  scanExpenseValues?: boolean;
};

/** Load filter definitions; optionally scan all expense values (off by default). */
export async function fetchFilterableCustomFields(
  organizationId: string,
  options?: FetchFilterableCustomFieldsOptions,
): Promise<FilterableCustomField[]> {
  const map = new Map<string, FilterableCustomField>();
  const definitions = await fetchFilterableCustomFieldDefinitions(organizationId);
  for (const field of definitions) {
    map.set(field.key, { ...field });
  }

  if (!options?.scanExpenseValues) {
    return [...map.values()];
  }

  const templateMetaById = new Map<
    string,
    { name: string; fieldType: "select" | "checkbox"; options: unknown }
  >();
  const branchMetaById = new Map<
    string,
    { name: string; fieldType: "select" | "checkbox"; options: unknown }
  >();

  const templates = await fetchAllPages<{ id: string; name: string; field_type: string; options: unknown }>(
    (offset, pageSize) =>
      supabase
        .from("expense_form_field_templates")
        .select("id, name, field_type, options")
        .eq("organization_id", organizationId)
        .in("field_type", ["select", "checkbox"])
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1),
    "expense_form_field_templates (filter value scan)",
  );
  for (const row of templates) {
    if (row.id && (row.field_type === "select" || row.field_type === "checkbox")) {
      templateMetaById.set(row.id, {
        name: row.name,
        fieldType: row.field_type,
        options: row.options,
      });
    }
  }

  const branches = await fetchAllPages<{ id: string; name: string; field_type: string; options: unknown }>(
    (offset, pageSize) =>
      supabase
        .from("expense_form_field_option_branches")
        .select("id, name, field_type, options")
        .eq("organization_id", organizationId)
        .in("field_type", ["select", "checkbox"])
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1),
    "expense_form_field_option_branches (filter value scan)",
  );
  for (const row of branches) {
    if (row.id && (row.field_type === "select" || row.field_type === "checkbox")) {
      branchMetaById.set(row.id, {
        name: row.name,
        fieldType: row.field_type,
        options: row.options,
      });
    }
  }

  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data: valueRows, error: valuesError } = await supabase
      .from("expense_form_field_values")
      .select("field_value, template_id, branch_field_id")
      .eq("organization_id", organizationId)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (valuesError) {
      console.warn("expense_form_field_values (filter discovery)", valuesError);
      break;
    }

    const rows = valueRows || [];
    for (const row of rows) {
      const value = String(row.field_value ?? "").trim();
      const tpl = row.template_id ? templateMetaById.get(row.template_id) : undefined;
      const branch = row.branch_field_id ? branchMetaById.get(row.branch_field_id) : undefined;

      if (tpl) {
        upsertFilterableField(map, tpl.name, tpl.fieldType, tpl.options, value ? [value] : []);
      } else if (branch) {
        upsertFilterableField(map, branch.name, branch.fieldType, branch.options, value ? [value] : []);
      }
    }

    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

function humanizeFieldKey(fieldKey: string): string {
  const trimmed = fieldKey.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveTemplateLabel(meta: {
  name?: string | null;
  field_key?: string | null;
}): string {
  const name = String(meta.name ?? "").trim();
  if (name) return name;
  const key = String(meta.field_key ?? "").trim();
  if (key) return humanizeFieldKey(key);
  return "";
}

async function fetchValueRowsForExpenseBatch(
  expenseIds: string[],
  organizationId: string,
  signal?: AbortSignal,
): Promise<
  {
    expense_id: string;
    field_value: string;
    template_id: string | null;
    branch_field_id: string | null;
  }[]
> {
  type ValueRow = {
    expense_id: string;
    field_value: string;
    template_id: string | null;
    branch_field_id: string | null;
  };

  const chunks = chunkArray(expenseIds, CUSTOM_FIELD_BATCH_SIZE);

  /**
   * Fetch one chunk with retry on statement-timeout (pg error 57014).
   * Falls back to no-org filter ONLY on schema-cache miss (42703).
   */
  async function fetchChunk(batch: string[], attempt = 0): Promise<ValueRow[]> {
    if (signal?.aborted) return [];

    const withOrg = await supabase
      .from("expense_form_field_values")
      .select("expense_id, field_value, template_id, branch_field_id")
      .in("expense_id", batch)
      .eq("organization_id", organizationId);

    if (!withOrg.error) {
      return (withOrg.data || []) as ValueRow[];
    }

    const errCode = (withOrg.error as { code?: string }).code ?? "";

    // Statement timeout — retry up to twice with exponential back-off.
    if (errCode === "57014" && attempt < 2) {
      await new Promise((res) => setTimeout(res, 300 * Math.pow(2, attempt)));
      return fetchChunk(batch, attempt + 1);
    }

    // Schema-cache miss — retry without org filter.
    if (errCode === "42703") {
      const withoutOrg = await supabase
        .from("expense_form_field_values")
        .select("expense_id, field_value, template_id, branch_field_id")
        .in("expense_id", batch);

      if (!withoutOrg.error) {
        return (withoutOrg.data || []) as ValueRow[];
      }
      console.warn("expense_form_field_values (no-org fallback)", withoutOrg.error);
      return [];
    }

    console.warn("expense_form_field_values (custom fields map)", withOrg.error);
    return [];
  }

  const tasks = chunks.map((batch) => () => fetchChunk(batch));
  const results = await runWithConcurrencyLimit<ValueRow[]>(tasks, MAX_CUSTOM_FIELD_CONCURRENCY, signal);

  return results.flatMap((r) => r ?? []);
}

async function fetchTemplateMetaByIds(
  templateIds: string[],
  organizationId: string,
): Promise<Map<string, { name: string; field_key: string | null }>> {
  const metaById = new Map<string, { name: string; field_key: string | null }>();
  if (templateIds.length === 0) return metaById;

  for (const batch of chunkArray(templateIds)) {
    for (const useOrg of [true, false] as const) {
      let query = supabase
        .from("expense_form_field_templates")
        .select("id, name, field_key")
        .in("id", batch);
      if (useOrg) {
        query = query.eq("organization_id", organizationId);
      }

      const { data, error } = await query;
      if (!error && data?.length) {
        for (const row of data) {
          metaById.set(row.id, {
            name: String(row.name ?? ""),
            field_key: (row.field_key as string | null) ?? null,
          });
        }
        break;
      }
    }
  }

  return metaById;
}

async function fetchBranchMetaByIds(
  branchIds: string[],
  organizationId: string,
): Promise<Map<string, { name: string; field_key: string | null }>> {
  const metaById = new Map<string, { name: string; field_key: string | null }>();
  if (branchIds.length === 0) return metaById;

  for (const batch of chunkArray(branchIds)) {
    for (const useOrg of [true, false] as const) {
      let query = supabase
        .from("expense_form_field_option_branches")
        .select("id, name, field_key")
        .in("id", batch);
      if (useOrg) {
        query = query.eq("organization_id", organizationId);
      }

      const { data, error } = await query;
      if (!error && data?.length) {
        for (const row of data) {
          metaById.set(row.id, {
            name: String(row.name ?? ""),
            field_key: (row.field_key as string | null) ?? null,
          });
        }
        break;
      }
    }
  }

  return metaById;
}

/** Template + hierarchy branch values keyed by field display name. */
export async function fetchExpenseCustomFieldsMap(
  organizationId: string,
  expenseIds: string[],
): Promise<Record<string, Record<string, string>>> {
  if (!organizationId || expenseIds.length === 0) return {};

  const result: Record<string, Record<string, string>> = {};
  const valueRows = await fetchValueRowsForExpenseBatch(expenseIds, organizationId);

  if (valueRows.length === 0) return result;

  const templateIds = [
    ...new Set(valueRows.map((r) => r.template_id).filter((id): id is string => Boolean(id))),
  ];
  const branchIds = [
    ...new Set(
      valueRows.map((r) => r.branch_field_id).filter((id): id is string => Boolean(id)),
    ),
  ];

  const [templateMetaById, branchMetaById] = await Promise.all([
    fetchTemplateMetaByIds(templateIds, organizationId),
    fetchBranchMetaByIds(branchIds, organizationId),
  ]);

  for (const row of valueRows) {
    const fieldValue = String(row.field_value ?? "").trim();
    if (!fieldValue) continue;

    let name = "";
    if (row.template_id) {
      const meta = templateMetaById.get(row.template_id);
      if (meta) name = resolveTemplateLabel(meta);
    }
    if (!name && row.branch_field_id) {
      const meta = branchMetaById.get(row.branch_field_id);
      if (meta) name = resolveTemplateLabel(meta);
    }
    if (!name && row.template_id) {
      name = "Custom field";
    }
    if (!name && row.branch_field_id) {
      name = "Custom field";
    }
    if (!name) continue;

    if (!result[row.expense_id]) result[row.expense_id] = {};
    result[row.expense_id][name] = fieldValue;
  }

  return result;
}

export type ExpensePeriodFilter = {
  year?: string;
  month?: string;
  category?: string;
};

async function fetchApprovedExpenseIdsForPeriod(
  organizationId: string,
  period: ExpensePeriodFilter = {},
  userId?: string,
): Promise<string[]> {
  let query = supabase
    .from("expenses")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("status", "approved");

  if (userId) query = query.eq("user_id", userId);

  if (period.category && period.category !== "all") {
    query = query.ilike("category", period.category);
  }
  if (period.year) {
    const yearStart = new Date(`${period.year}-01-01`);
    const yearEnd = new Date(`${period.year}-12-31`);
    yearEnd.setHours(23, 59, 59, 999);
    query = query
      .gte("trip_start", yearStart.toISOString().split("T")[0])
      .lte("trip_start", yearEnd.toISOString().split("T")[0]);
  }
  if (period.month && period.month !== "all" && period.year) {
    const monthNum = parseInt(period.month, 10);
    const monthStart = new Date(parseInt(period.year, 10), monthNum - 1, 1);
    const monthEnd = new Date(parseInt(period.year, 10), monthNum, 0);
    query = query
      .gte("trip_start", monthStart.toISOString().split("T")[0])
      .lte("trip_start", monthEnd.toISOString().split("T")[0]);
  }

  const { data: expenses, error } = await query;
  if (error) throw error;
  return (expenses || []).map((row) => row.id as string);
}

async function buildFilledCustomFieldValuesFromExpenseIds(
  organizationId: string,
  expenseIds: string[],
): Promise<Record<string, Set<string>>> {
  const customByExpense = await fetchExpenseCustomFieldsMap(organizationId, expenseIds);
  const filled: Record<string, Set<string>> = {};
  for (const fieldMap of Object.values(customByExpense)) {
    for (const [fieldName, rawValue] of Object.entries(fieldMap)) {
      const value = String(rawValue ?? "").trim();
      if (!value) continue;
      if (!filled[fieldName]) filled[fieldName] = new Set();
      filled[fieldName].add(value);
    }
  }
  return filled;
}

/** Distinct custom field values on all approved expenses in the period (all employees). */
export async function fetchFilledCustomFieldValuesForOrganization(
  organizationId: string,
  period: ExpensePeriodFilter = {},
): Promise<Record<string, Set<string>>> {
  const expenseIds = await fetchApprovedExpenseIdsForPeriod(organizationId, period);
  return buildFilledCustomFieldValuesFromExpenseIds(organizationId, expenseIds);
}

/** Distinct custom field values this employee has on approved expenses in the period. */
export async function fetchFilledCustomFieldValuesForEmployee(
  organizationId: string,
  userId: string,
  period: ExpensePeriodFilter = {},
): Promise<Record<string, Set<string>>> {
  const expenseIds = await fetchApprovedExpenseIdsForPeriod(organizationId, period, userId);
  return buildFilledCustomFieldValuesFromExpenseIds(organizationId, expenseIds);
}

export function isCustomFieldChoiceFilled(
  fieldKey: string,
  choiceValue: string,
  filledValuesByField?: Record<string, Set<string>>,
): boolean {
  if (!filledValuesByField) return true;
  const filled = filledValuesByField[fieldKey];
  if (!filled || filled.size === 0) return false;
  return filled.has(choiceValue);
}
