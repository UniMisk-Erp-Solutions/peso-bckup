/**
 * Bulk CSV import parsing + validation for admin-submit-for-employee.
 *
 * Scope decision, documented rather than hidden: this integration ships a
 * CSV-only bulk importer, not the source branch's (Preet-Patel/feature/
 * admin-submit-expense-for-employee, commit 3aa8f66d) live-Excel-dropdown
 * roster generator. That generator adds a new runtime dependency (`exceljs`,
 * needed because the project's existing `xlsx` package can only READ Excel
 * data validation, not write it) purely for spreadsheet-authoring UX polish
 * — it has no bearing on server-side correctness or safety, since every
 * value is re-validated here and again, authoritatively, inside
 * admin_bulk_submit_expenses_v2 regardless of how the file was produced. A
 * plain CSV template with a companion "valid values" reference section
 * (see buildBulkExpenseCsvTemplate) delivers the same actual capability
 * (current categories, current required custom fields, current conditional
 * branch options) without a new dependency. If live in-cell dropdowns are
 * wanted later, this module's validation logic does not need to change —
 * only the template-generation side would.
 *
 * Client-chunk cap (250-row hard server limit; see BULK_SUBMIT_CHUNK_SIZE in
 * adminSubmitExpense.ts) exists so a corrupted/mistaken huge paste fails
 * fast with a clear message rather than partially processing.
 */
import { parseTabularText } from "@/lib/formBuilder/dropdownBulkImport";
import type { CustomFieldValuePayload } from "@/lib/adminSubmitExpense";
import {
  categoryFormFieldsForName,
  optionBranchesForTemplates,
  type OrganizationExpenseFieldConfig,
} from "@/lib/orgExpenseFieldConfig";

const BASE_HEADERS = [
  "employee_id",
  "email",
  "title",
  "destination",
  "trip_start",
  "trip_end",
  "category",
  "amount",
  "purpose",
] as const;

export type BulkRowInput = {
  rowIndex: number;
  raw: Record<string, string>;
  /**
   * Set when this data row's cell count does not match the header row's.
   * The classic cause: a value like `1,000` typed WITHOUT CSV quoting — the
   * comma is then read as a column delimiter, silently shifting every later
   * column by one (e.g. amount becomes "1" and the real amount's remainder
   * bleeds into the next column). Positional header->cell mapping cannot
   * detect this on its own (it just reads whatever cell lands at each
   * index), so the mismatch is captured here and validateBulkRow turns it
   * into a hard, visible error instead of a silently wrong amount.
   */
  columnCountMismatch?: { expected: number; actual: number };
};

export type BulkRowValidationResult = {
  rowIndex: number;
  ok: boolean;
  errors: string[];
  employeeId: string | null;
  email: string | null;
  title: string;
  destination: string;
  tripStartIso: string | null;
  tripEndIso: string | null;
  category: string;
  amount: number | null;
  purpose: string | null;
  customFieldValues: CustomFieldValuePayload[];
};

/** DD-MM-YYYY -> YYYY-MM-DD. Never trusts PostgreSQL's DateStyle-dependent
 * parsing of an ambiguous day-first string. Returns null when malformed. */
export function parseDDMMYYYYToIso(value: string): string | null {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d);
  const month = Number(mo);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export function parseBulkExpenseCsv(text: string): { headers: string[]; rows: BulkRowInput[] } {
  const table = parseTabularText(text, ",");
  if (table.length === 0) return { headers: [], rows: [] };
  const headers = table[0].map((h) => h.trim());
  const rows: BulkRowInput[] = [];
  for (let i = 1; i < table.length; i++) {
    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => {
      raw[h] = (table[i][idx] ?? "").trim();
    });
    const expected = headers.length;
    const actual = table[i].length;
    rows.push({
      rowIndex: i - 1,
      raw,
      ...(actual !== expected ? { columnCountMismatch: { expected, actual } } : {}),
    });
  }
  return { headers, rows };
}

/** Field:<template name> / Branch:<parent template name>::<branch name> column keys. */
function fieldColumnKey(templateName: string): string {
  return `Field:${templateName}`;
}
function branchColumnKey(parentTemplateName: string, branchName: string): string {
  return `Branch:${parentTemplateName}::${branchName}`;
}

/**
 * Validates one row against the org's CURRENT field configuration. Server
 * validation (inside admin_bulk_submit_expenses_v2 /
 * admin_submit_expense_for_employee_v2) is authoritative regardless of what
 * this function decides — this exists to give the admin fast, row-level
 * feedback before spending a network round trip.
 */
export function validateBulkRow(
  input: BulkRowInput,
  config: OrganizationExpenseFieldConfig | null,
): BulkRowValidationResult {
  const { raw, rowIndex, columnCountMismatch } = input;
  const errors: string[] = [];

  if (columnCountMismatch) {
    errors.push(
      `row has ${columnCountMismatch.actual} columns but the header has ${columnCountMismatch.expected} — ` +
        `check for a value containing an unquoted comma (e.g. an amount like 1,000 must be written as 1000, ` +
        `or quoted as "1,000"); every column after it may be shifted and wrong`,
    );
  }

  const employeeId = raw.employee_id?.trim() || null;
  const email = raw.email?.trim() || null;
  if (!employeeId && !email) errors.push("row has neither employee_id nor email");

  const title = raw.title?.trim() || "";
  if (!title) errors.push("title is required");
  const destination = raw.destination?.trim() || "";
  if (!destination) errors.push("destination is required");
  const category = raw.category?.trim() || "";
  if (!category) errors.push("category is required");

  const tripStartIso = raw.trip_start ? parseDDMMYYYYToIso(raw.trip_start) : null;
  if (!raw.trip_start || !tripStartIso) errors.push("trip_start must be DD-MM-YYYY");
  const tripEndIso = raw.trip_end ? parseDDMMYYYYToIso(raw.trip_end) : null;
  if (!raw.trip_end || !tripEndIso) errors.push("trip_end must be DD-MM-YYYY");

  const amountRaw = raw.amount?.trim() || "";
  const amount = amountRaw ? Number(amountRaw) : NaN;
  if (!amountRaw || !Number.isFinite(amount) || amount <= 0) {
    errors.push("amount must be a number greater than zero");
  }

  const purpose = raw.purpose?.trim() || null;

  const customFieldValues: CustomFieldValuePayload[] = [];
  if (config && category) {
    const templates = categoryFormFieldsForName(config, category);
    const templateIds = templates.map((t) => t.template.id);
    const branches = optionBranchesForTemplates(config, templateIds);

    for (const { template, required } of templates) {
      const columnKey = fieldColumnKey(template.name);
      const value = raw[columnKey]?.trim() ?? "";
      const isRequired = required ?? template.required;
      if (isRequired && !value) {
        errors.push(`"${template.name}" is required for category "${category}"`);
        continue;
      }
      if (value) {
        if (template.field_type === "select" && template.options?.length && !template.options.includes(value)) {
          errors.push(`"${value}" is not a valid option for "${template.name}"`);
          continue;
        }
        customFieldValues.push({ template_id: template.id, field_value: value });

        // Conditional branch(es) whose parent is this template's chosen value.
        const childBranches = branches.filter(
          (b) => b.parent_template_id === template.id && b.parent_option_value === value,
        );
        for (const branch of childBranches) {
          const branchKey = branchColumnKey(template.name, branch.name);
          const branchValue = raw[branchKey]?.trim() ?? "";
          if (branch.required && !branchValue) {
            errors.push(`"${branch.name}" is required when "${template.name}" is "${value}"`);
            continue;
          }
          if (branchValue) {
            if (branch.options?.length && !branch.options.includes(branchValue)) {
              errors.push(`"${branchValue}" is not a valid option for "${branch.name}"`);
              continue;
            }
            customFieldValues.push({ branch_field_id: branch.id, field_value: branchValue });
          }
        }
      }
    }
  }

  return {
    rowIndex,
    ok: errors.length === 0,
    errors,
    employeeId,
    email,
    title,
    destination,
    tripStartIso,
    tripEndIso,
    category,
    amount: Number.isFinite(amount) ? amount : null,
    purpose,
    customFieldValues,
  };
}

export function validateBulkRows(
  rows: BulkRowInput[],
  config: OrganizationExpenseFieldConfig | null,
): BulkRowValidationResult[] {
  return rows.map((row) => validateBulkRow(row, config));
}

/**
 * Plain-CSV template + a reference block listing current categories and
 * required custom fields, so the admin knows what to fill in without a live
 * Excel dropdown. See module header for why this is CSV, not `.xlsx`.
 */
export function buildBulkExpenseCsvTemplate(config: OrganizationExpenseFieldConfig | null): string {
  const lines: string[] = [];
  lines.push([...BASE_HEADERS].join(","));
  lines.push("EMP001,,Client visit,Site A,01-09-2026,01-09-2026,Travel,500,");
  lines.push("");
  lines.push("# Reference — current categories and their required fields");
  if (config) {
    for (const [name, id] of config.categoriesById) {
      const fields = config.categoryFormFieldsByCategory.get(id) ?? [];
      const requiredNames = fields
        .filter((f) => f.required ?? f.template.required)
        .map((f) => f.template.name);
      lines.push(`# ${name}${requiredNames.length ? ` (required: ${requiredNames.join(", ")})` : ""}`);
    }
  }
  return lines.join("\n");
}
