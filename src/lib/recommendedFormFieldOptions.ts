import { supabase } from "@/integrations/supabase/client";
import { ExpenseService } from "@/services/ExpenseService";

// ---------------------------------------------------------------------------
// Shared usage-tracking data layer
//
// Problem: many dropdown components each called fetchRecommendedOptionsForFields
// independently, each firing a separate DB query. With 10-20 dropdowns on a
// form, that produced 10-20 concurrent requests to the Supabase instance.
//
// Fix: one shared query per (organizationId, userId) pair.
//  - Request coalescing: concurrent callers share the same in-flight Promise.
//  - 60s result cache: re-renders within the same form session reuse the result.
//  - No .in() filter: avoids 414 "Request URI Too Long" when fieldKeys is large.
//  - Cache is invalidated on every trackFormFieldOptionUsage call so the next
//    render picks up fresh recency data.
// ---------------------------------------------------------------------------

type UsageRow = {
  field_key: string;
  field_kind: string;
  option_value: string;
  usage_count: number;
  last_used_at: string;
};

const _inflightFetches = new Map<string, Promise<UsageRow[]>>();
const _resultCache = new Map<string, { data: UsageRow[]; ts: number }>();
const USAGE_CACHE_TTL_MS = 60_000;

function _usageCacheKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

/** Fetch all usage rows for a user/org — shared across components. */
async function _fetchAllUsageRows(organizationId: string, userId: string): Promise<UsageRow[]> {
  const key = _usageCacheKey(organizationId, userId);

  const cached = _resultCache.get(key);
  if (cached && Date.now() - cached.ts < USAGE_CACHE_TTL_MS) return cached.data;

  const existing = _inflightFetches.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<UsageRow[]> => {
    const { data, error } = await supabase
      .from("form_field_option_usage_tracking")
      .select("field_key, field_kind, option_value, usage_count, last_used_at")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .order("usage_count", { ascending: false })
      .order("last_used_at", { ascending: false });

    _inflightFetches.delete(key);
    if (error || !data) {
      console.error("fetchAllUsageRows:", error);
      return [];
    }
    _resultCache.set(key, { data: data as UsageRow[], ts: Date.now() });
    return data as UsageRow[];
  })();

  _inflightFetches.set(key, promise);
  return promise;
}

/** Invalidate the cached usage data so the next render fetches fresh rows. */
function _invalidateUsageCache(organizationId: string, userId: string): void {
  _resultCache.delete(_usageCacheKey(organizationId, userId));
}

export type FormFieldKind = "template" | "branch" | "base";

export type SelectFieldRef = {
  fieldKey: string;
  fieldKind: FormFieldKind;
  options: string[];
};

export function fieldRecKey(fieldKind: FormFieldKind, fieldKey: string): string {
  return `${fieldKind}:${fieldKey}`;
}

export const RECENT_FORM_FIELD_OPTIONS_LIMIT = 4;

function topRecentFromOptions(allOptions: string[], used: string[]): string[] {
  let recommended = used.filter((v) => allOptions.includes(v)).slice(0, RECENT_FORM_FIELD_OPTIONS_LIMIT);
  if (recommended.length < RECENT_FORM_FIELD_OPTIONS_LIMIT) {
    const remaining = allOptions.filter((o) => !recommended.includes(o));
    recommended = [
      ...recommended,
      ...remaining.slice(0, RECENT_FORM_FIELD_OPTIONS_LIMIT - recommended.length),
    ];
  }
  return recommended.slice(0, RECENT_FORM_FIELD_OPTIONS_LIMIT);
}

/** Top recent option values per select field (usage history, then first options as fallback). */
export async function fetchRecommendedOptionsForFields(
  organizationId: string,
  userId: string,
  fields: SelectFieldRef[],
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  if (!organizationId || !userId || fields.length === 0) return result;

  const withOptions = fields.filter((f) => f.options.length > 0);
  for (const f of withOptions) {
    result[fieldRecKey(f.fieldKind, f.fieldKey)] = f.options.slice(0, RECENT_FORM_FIELD_OPTIONS_LIMIT);
  }

  try {
    if (withOptions.length === 0) return result;

    // Use the shared per-user/org fetch: one DB call, coalesced across all concurrent
    // callers (multiple dropdown components), result cached for 60 s.
    const rows = await _fetchAllUsageRows(organizationId, userId);

    for (const field of withOptions) {
      const key = fieldRecKey(field.fieldKind, field.fieldKey);
      const ranked = rows
        .filter(
          (row) =>
            row.field_key === field.fieldKey &&
            row.field_kind === field.fieldKind &&
            field.options.includes(row.option_value),
        )
        .map((row) => row.option_value);
      result[key] = topRecentFromOptions(field.options, ranked);
    }
  } catch (e) {
    console.error("fetchRecommendedOptionsForFields:", e);
  }

  return result;
}

export async function trackFormFieldOptionUsage(
  organizationId: string,
  userId: string,
  fieldKey: string,
  fieldKind: FormFieldKind,
  optionValue: string,
): Promise<void> {
  const trimmed = optionValue?.trim();
  if (!trimmed || !organizationId || !userId) return;

  const { error } = await supabase.rpc("increment_form_field_option_usage", {
    p_organization_id: organizationId,
    p_user_id: userId,
    p_field_key: fieldKey,
    p_field_kind: fieldKind,
    p_option_value: trimmed,
  });

  if (error) {
    console.warn("trackFormFieldOptionUsage:", error.message);
  }

  // Invalidate the shared cache so the next render fetches fresh recency data.
  _invalidateUsageCache(organizationId, userId);
}

export async function trackFormFieldSelections(
  organizationId: string,
  userId: string,
  params: {
    templateSelects?: Array<{ templateId: string; value: string }>;
    branchSelects?: Array<{ branchId: string; value: string }>;
  },
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const t of params.templateSelects ?? []) {
    if (t.value?.trim()) {
      tasks.push(
        trackFormFieldOptionUsage(organizationId, userId, t.templateId, "template", t.value),
      );
    }
  }
  for (const b of params.branchSelects ?? []) {
    if (b.value?.trim()) {
      tasks.push(
        trackFormFieldOptionUsage(organizationId, userId, b.branchId, "branch", b.value),
      );
    }
  }
  await Promise.all(tasks);
}

/**
 * Track base expense field selections that use a dropdown input override.
 * Values map is keyed by base field key (e.g. { destination: "Site A" }).
 */
export async function trackBaseFieldSelections(
  organizationId: string,
  userId: string,
  baseFields: Array<{ field_key: string; input_type: string }>,
  values: Record<string, string | null | undefined>,
): Promise<void> {
  if (!organizationId || !userId) return;
  const tasks: Promise<void>[] = [];
  for (const field of baseFields) {
    if (field.input_type !== "dropdown") continue;
    const value = values[field.field_key];
    if (value && String(value).trim()) {
      tasks.push(
        trackFormFieldOptionUsage(organizationId, userId, field.field_key, "base", String(value)),
      );
    }
  }
  await Promise.all(tasks);
}

/** Track batch/single saves when only category + value maps are known. */
export async function trackFormFieldSelectionsForCategory(
  organizationId: string,
  userId: string,
  categoryName: string,
  formFieldValues: Record<string, string>,
  branchValues: Record<string, string>,
  allowConditionalDropdown: boolean,
): Promise<void> {
  if (!categoryName?.trim()) return;

  const { data: categoryData } = await supabase
    .from("expense_categories")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("name", categoryName)
    .maybeSingle();

  if (!categoryData) return;

  const { data: assignments } = await supabase
    .from("expense_category_form_fields")
    .select("template_id, expense_form_field_templates(field_type)")
    .eq("organization_id", organizationId)
    .eq("category_id", categoryData.id);

  const templateSelects: Array<{ templateId: string; value: string }> = [];
  for (const row of assignments || []) {
    const tpl = row.expense_form_field_templates as { field_type?: string } | null;
    if (tpl?.field_type === "select") {
      const val = formFieldValues[row.template_id];
      if (val?.trim()) {
        templateSelects.push({ templateId: row.template_id, value: val });
      }
    }
  }

  let branchSelects: Array<{ branchId: string; value: string }> = [];
  if (allowConditionalDropdown && templateSelects.length > 0) {
    const selectIds = templateSelects.map((t) => t.templateId);
    const branches = await ExpenseService.fetchOptionBranchesForTemplates(
      organizationId,
      selectIds,
    );
    branchSelects = branches
      .filter((b) => b.field_type === "select" && branchValues[b.id]?.trim())
      .map((b) => ({ branchId: b.id, value: branchValues[b.id] }));
  }

  await trackFormFieldSelections(organizationId, userId, { templateSelects, branchSelects });
}
