/**
 * DOC-108 follow-up — fetches an organization's FULL custom expense-field
 * configuration (base field overrides, category templates, conditional
 * branches) for the admin bulk-import roster generator and parser.
 *
 * Deliberately NOT reusing useOnDemandOptionBranches / fetchRuntimeOptionBranches
 * here: those fetch exactly one (template, option) pair at a time by design —
 * right for live form rendering, wrong for roster generation, which needs the
 * COMPLETE branch set to lay out every possible column. MicroLink alone has
 * 1,008 raw branch rows, right at PostgREST's default page-size cap — the
 * exact silent-truncation bug DOC-097 already had to hotfix once for an
 * unbounded branch fetch (see useOnDemandOptionBranches.ts's own comment).
 * fetchAllOptionBranches below pages explicitly via .range() so it can never
 * repeat that bug, no matter how large an org's configuration grows.
 */
import { supabase } from "@/integrations/supabase/client";
import { resolveBaseFieldConfig, type BaseExpenseFieldKey, type BaseFieldConfig } from "@/lib/expenseFormConfig";

// expense_form_field_templates / expense_category_form_fields /
// expense_form_field_option_branches / organization_expense_form_fields all
// predate the generated types.ts (same root cause documented in
// src/lib/adminSubmitExpense.ts) — narrow cast, not a new pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const PAGE_SIZE = 500;

/** Pages through a table via .range() until a page returns fewer rows than requested. Never trusts a single unbounded select for a table that can exceed PostgREST's row cap. */
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

export interface CustomFieldTemplate {
  id: string;
  name: string;
  field_type: "text" | "number" | "date" | "textarea" | "select" | "checkbox";
  required: boolean;
  default_value: string | null;
  placeholder: string | null;
  help_text: string | null;
  validation_rules: { min?: number; max?: number } | null;
  options: string[] | null;
}

export interface CategoryTemplateAssignment {
  template: CustomFieldTemplate;
  categoryId: string;
  categoryName: string;
  requiredOverride: boolean | null;
  displayOrder: number;
}

export interface OptionBranchRow {
  id: string;
  parentTemplateId: string;
  parentOptionValue: string;
  name: string;
  fieldType: string;
  required: boolean;
  options: string[] | null;
  defaultValue: string | null;
}

/** One logical spreadsheet column for a conditional branch field, collapsing every
 *  parent-option-value row that shares (parent_template_id, name) into one column —
 *  see generateBulkExpenseExcelTemplate.ts for why keying on name alone is unsafe. */
export interface BranchColumnGroup {
  key: string;
  parentTemplateId: string;
  parentTemplateName: string;
  name: string;
  fieldType: string;
  required: boolean;
  /** True when ANOTHER parent template also has a branch with this same
   *  display name — the column header must disambiguate in that case. */
  ambiguousName: boolean;
  rows: OptionBranchRow[];
}

export interface OrganizationExpenseFieldConfig {
  baseFieldConfig: Record<BaseExpenseFieldKey, BaseFieldConfig>;
  templates: CustomFieldTemplate[];
  categoryAssignments: CategoryTemplateAssignment[];
  branchGroups: BranchColumnGroup[];
}

export async function fetchOrganizationBaseFieldConfig(
  organizationId: string,
): Promise<Record<BaseExpenseFieldKey, BaseFieldConfig>> {
  const { data, error } = await db
    .from("organization_expense_form_fields")
    .select("*")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return resolveBaseFieldConfig(data as Partial<BaseFieldConfig>[]);
}

/** All active (non-retired) templates assigned to at least one active category, with their assignment metadata. */
export async function fetchCategoryTemplateAssignments(
  organizationId: string,
): Promise<CategoryTemplateAssignment[]> {
  // Embedded resources are filtered client-side below rather than via
  // PostgREST dot-notation filters on the embed (e.g. "template.retired_at")
  // — both organization_id columns are already direct, indexed columns on
  // this table and expense_form_field_templates respectively, so this stays
  // one org-scoped query; only the retired-template exclusion happens after.
  const rows = await fetchAllRows<any>((from, to) =>
    db
      .from("expense_category_form_fields")
      .select(`
        category_id, required, display_order,
        expense_categories(name, organization_id),
        expense_form_field_templates(*)
      `)
      .eq("organization_id", organizationId)
      .range(from, to),
  );

  return rows
    .filter((r) => r.expense_form_field_templates && !r.expense_form_field_templates.retired_at)
    .filter((r) => r.expense_categories?.organization_id === organizationId)
    .map((r) => ({
      template: normalizeTemplate(r.expense_form_field_templates),
      categoryId: r.category_id,
      categoryName: r.expense_categories?.name ?? "",
      requiredOverride: r.required,
      displayOrder: r.display_order ?? 0,
    }));
}

function normalizeTemplate(t: any): CustomFieldTemplate {
  return {
    id: t.id,
    name: t.name,
    field_type: t.field_type,
    required: Boolean(t.required),
    default_value: t.default_value ?? null,
    placeholder: t.placeholder ?? null,
    help_text: t.help_text ?? null,
    validation_rules: t.validation_rules ?? null,
    options: parseOptionsJsonb(t.options),
  };
}

function parseOptionsJsonb(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const arr = raw.map((v) => String(v).trim()).filter(Boolean);
  return arr.length > 0 ? arr : null;
}

/** All active option branches for the org, paginated — see module comment for why this must never be a single unbounded select. */
async function fetchAllOptionBranches(organizationId: string): Promise<OptionBranchRow[]> {
  const rows = await fetchAllRows<any>((from, to) =>
    db
      .from("expense_form_field_option_branches")
      .select("id, parent_template_id, parent_option_value, name, field_type, required, options, default_value")
      .eq("organization_id", organizationId)
      .is("retired_at", null)
      .is("parent_branch_id", null) // real data is depth-1 everywhere today; nested branches are out of scope for the flat spreadsheet (see docs)
      .range(from, to),
  );
  return rows.map((r) => ({
    id: r.id,
    parentTemplateId: r.parent_template_id,
    parentOptionValue: r.parent_option_value,
    name: r.name,
    fieldType: r.field_type,
    required: Boolean(r.required),
    options: parseOptionsJsonb(r.options),
    defaultValue: r.default_value ?? null,
  }));
}

/** Groups raw branch rows into one column per (parent_template_id, name), and flags
 *  any display-name collision across DIFFERENT parent templates so the roster
 *  generator can disambiguate the header instead of silently merging two
 *  unrelated fields — nothing in the schema enforces branch-name uniqueness. */
export function groupOptionBranches(
  rows: OptionBranchRow[],
  templatesById: Map<string, CustomFieldTemplate>,
): BranchColumnGroup[] {
  const groups = new Map<string, BranchColumnGroup>();
  for (const r of rows) {
    const key = `${r.parentTemplateId}::${r.name.trim().toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        parentTemplateId: r.parentTemplateId,
        parentTemplateName: templatesById.get(r.parentTemplateId)?.name ?? "",
        name: r.name,
        fieldType: r.fieldType,
        required: r.required,
        ambiguousName: false,
        rows: [],
      };
      groups.set(key, g);
    } else {
      // Same logical field replicated per parent option value — required is
      // OR'd (never silently under-mark a field some rows do require); a
      // field_type mismatch across rows sharing (template, name) would be a
      // genuine data inconsistency in this org's config, not expected in
      // practice, so it's left visible via the row-level fieldType rather
      // than hidden behind one column-level assumption.
      g.required = g.required || r.required;
    }
    g.rows.push(r);
  }

  const nameToTemplates = new Map<string, Set<string>>();
  for (const g of groups.values()) {
    const nk = g.name.trim().toLowerCase();
    if (!nameToTemplates.has(nk)) nameToTemplates.set(nk, new Set());
    nameToTemplates.get(nk)!.add(g.parentTemplateId);
  }
  for (const g of groups.values()) {
    g.ambiguousName = (nameToTemplates.get(g.name.trim().toLowerCase())?.size ?? 0) > 1;
  }

  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The column header text for a branch group — disambiguated with the parent
 *  template's name only when the bare branch name collides across templates. */
export function branchColumnHeader(group: BranchColumnGroup): string {
  return group.ambiguousName
    ? `Branch: ${group.parentTemplateName} → ${group.name}`
    : `Branch: ${group.name}`;
}

/** Fetches everything needed to render/validate this org's custom expense fields, in one place. */
export async function fetchOrganizationExpenseFieldConfig(
  organizationId: string,
): Promise<OrganizationExpenseFieldConfig> {
  const [baseFieldConfig, categoryAssignments, branchRows] = await Promise.all([
    fetchOrganizationBaseFieldConfig(organizationId),
    fetchCategoryTemplateAssignments(organizationId),
    fetchAllOptionBranches(organizationId),
  ]);

  const templatesById = new Map<string, CustomFieldTemplate>();
  for (const a of categoryAssignments) templatesById.set(a.template.id, a.template);

  const templates = [...templatesById.values()];
  const branchGroups = groupOptionBranches(branchRows, templatesById);

  return { baseFieldConfig, templates, categoryAssignments, branchGroups };
}
