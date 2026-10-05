/**
 * Organization expense-field configuration for the admin-submit-for-employee
 * feature (single form and bulk import both use this).
 *
 * Ported and adapted from Preet-Patel/feature/admin-submit-expense-for-employee
 * commit 46ea9f9b's src/lib/orgExpenseFieldConfig.ts. The pagination guard is
 * unchanged: expense_form_field_option_branches has been observed to exceed
 * 1,000 rows for a single organization (DOC-097's own incident), so this
 * module never issues a single unbounded select against it.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  resolveBaseFieldConfig,
  normalizeBaseFieldOptions,
  type BaseExpenseFieldKey,
  type BaseFieldConfig,
} from "@/lib/expenseFormConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const PAGE_SIZE = 500;

/**
 * Pages through a table via .range() until a page returns fewer rows than
 * requested. Never trusts a single unbounded select for a table that can
 * exceed PostgREST's row cap.
 */
async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

export type CategoryFormFieldRow = {
  required: boolean | null;
  show_on_submit?: boolean | null;
  template: {
    id: string;
    name: string;
    field_type: string;
    required: boolean;
    placeholder?: string | null;
    help_text?: string | null;
    validation_rules?: { min?: number; max?: number };
    options?: string[] | null;
    show_on_submit?: boolean | null;
  };
};

export type OptionBranchRow = {
  id: string;
  parent_template_id: string;
  parent_option_value: string;
  name: string;
  field_type: string;
  required: boolean;
  options: string[] | null;
  default_value: string | null;
};

export type OrganizationExpenseFieldConfig = {
  baseFields: Record<BaseExpenseFieldKey, BaseFieldConfig>;
  categoriesById: Map<string, string>;
  categoryFormFieldsByCategory: Map<string, CategoryFormFieldRow[]>;
  /** All active, depth-1 option branches for the org, flat — filtered per
   * template/parent value by the caller. Real data is depth-1 everywhere
   * today; nested branches are out of scope for the flat bulk spreadsheet. */
  optionBranches: OptionBranchRow[];
};

/** All base-field config rows for the org (relabeling/hiding/required/dropdown overrides). */
async function fetchBaseFieldConfig(organizationId: string): Promise<Record<BaseExpenseFieldKey, BaseFieldConfig>> {
  const { data, error } = await db
    .from("organization_expense_form_fields")
    .select("field_key, label, help_text, is_visible, is_required, display_order, show_on_submit, show_on_review, show_on_detail, input_type, options")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return resolveBaseFieldConfig(
    (data ?? []).map((row: Record<string, unknown>) => ({
      ...row,
      options: normalizeBaseFieldOptions(row.options),
    })),
  );
}

/** All active expense categories for the org, id keyed by lowercased name. */
async function fetchCategories(organizationId: string): Promise<Map<string, string>> {
  const rows = await fetchAllRows<{ id: string; name: string }>((from, to) =>
    db
      .from("expense_categories")
      .select("id, name")
      .eq("organization_id", organizationId)
      .range(from, to),
  );
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.name.toLowerCase(), row.id);
  return map;
}

/** Category-assigned custom field templates, grouped by category id. */
async function fetchCategoryFormFields(organizationId: string): Promise<Map<string, CategoryFormFieldRow[]>> {
  const rows = await fetchAllRows<Record<string, unknown>>((from, to) =>
    db
      .from("expense_category_form_fields")
      .select("category_id, required, show_on_submit, expense_form_field_templates(*)")
      .eq("organization_id", organizationId)
      .order("display_order", { ascending: true })
      .range(from, to),
  );
  const byCategory = new Map<string, CategoryFormFieldRow[]>();
  for (const row of rows) {
    const template = row.expense_form_field_templates as CategoryFormFieldRow["template"];
    if (!template) continue;
    const submitFlag = row.show_on_submit as boolean | null | undefined;
    const templateSubmitFlag = template.show_on_submit;
    if ((submitFlag ?? templateSubmitFlag ?? true) !== true) continue;
    const categoryId = row.category_id as string;
    const list = byCategory.get(categoryId) ?? [];
    list.push({ required: row.required as boolean | null, template });
    byCategory.set(categoryId, list);
  }
  return byCategory;
}

/**
 * All active option branches for the org, paginated — see module comment
 * for why this must never be a single unbounded select.
 */
async function fetchAllOptionBranches(organizationId: string): Promise<OptionBranchRow[]> {
  return fetchAllRows<OptionBranchRow>((from, to) =>
    db
      .from("expense_form_field_option_branches")
      .select("id, parent_template_id, parent_option_value, name, field_type, required, options, default_value")
      .eq("organization_id", organizationId)
      .is("retired_at", null)
      .is("parent_branch_id", null)
      .range(from, to),
  );
}

export async function loadOrganizationExpenseFieldConfig(
  organizationId: string,
): Promise<OrganizationExpenseFieldConfig> {
  const [baseFields, categoriesById, categoryFormFieldsByCategory, optionBranches] = await Promise.all([
    fetchBaseFieldConfig(organizationId),
    fetchCategories(organizationId),
    fetchCategoryFormFields(organizationId),
    fetchAllOptionBranches(organizationId),
  ]);
  return { baseFields, categoriesById, categoryFormFieldsByCategory, optionBranches };
}

/** Category-assigned templates for one category name (case-insensitive), or []. */
export function categoryFormFieldsForName(
  config: OrganizationExpenseFieldConfig,
  categoryName: string,
): CategoryFormFieldRow[] {
  const categoryId = config.categoriesById.get(categoryName.trim().toLowerCase());
  if (!categoryId) return [];
  return config.categoryFormFieldsByCategory.get(categoryId) ?? [];
}

/** Option-branch definitions whose parent template is one of the given ids. */
export function optionBranchesForTemplates(
  config: OrganizationExpenseFieldConfig,
  templateIds: string[],
): OptionBranchRow[] {
  const set = new Set(templateIds);
  return config.optionBranches.filter((b) => set.has(b.parent_template_id));
}
