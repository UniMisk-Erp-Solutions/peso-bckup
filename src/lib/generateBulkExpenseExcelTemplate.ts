/**
 * DOC-108 follow-up — per-organization, pre-filled bulk-import Excel template,
 * now with org-accurate custom fields: base-field label/visibility/required
 * overrides (including a base field turned into a dropdown, e.g. MicroLink's
 * "Customer / Site Location"), one column per category-assigned custom
 * template, and one column per conditional branch field — the exact same
 * fields the employee's own "My Expenses" form would show, driven by the
 * same organization_expense_form_fields / expense_form_field_templates /
 * expense_form_field_option_branches config (see src/lib/orgExpenseFieldConfig.ts).
 *
 * Deliberately takes only plain data (employees, categories, field config) as
 * arguments — it has no concept of "organization" and does no fetching of its
 * own. Every safety guarantee against mixing two organizations' data comes
 * from the caller passing already org-scoped data, not a new query surface
 * here that could drift out of sync.
 *
 * The `xlsx` package already used elsewhere in this codebase can only READ
 * Excel data validation, not write it (confirmed against the installed
 * 0.18.5 build). `exceljs` writes real, clickable dropdowns.
 *
 * Branch (conditional) fields are DELIBERATELY plain validated text columns,
 * not live cascading Excel dropdowns: a dependent dropdown would need one
 * Excel defined name per parent option value (~500+ for MicroLink), which
 * have real naming constraints raw option values like "197001M3" won't
 * satisfy without lossy sanitizing — far more fragile than the one-hidden-
 * sheet static-list technique already proven here. Instead, a second
 * VISIBLE "Reference" sheet lists every parent-value → valid-values mapping
 * as a plain, Ctrl+F-able lookup table.
 */
import type { OrganizationUserRow } from "@/lib/orgUsers";
import type { BaseExpenseFieldKey, BaseFieldConfig } from "@/lib/expenseFormConfig";
import type { CategoryTemplateAssignment, BranchColumnGroup } from "@/lib/orgExpenseFieldConfig";
import { branchColumnHeader } from "@/lib/orgExpenseFieldConfig";

export const BULK_TEMPLATE_HEADERS = [
  "Employee Name", "Employee ID", "Employee Email",
  "Title", "Destination", "Date (DD-MM-YYYY)", "Category", "Amount", "Purpose",
] as const;

export interface BulkTemplateFieldConfig {
  baseFieldConfig: Record<BaseExpenseFieldKey, BaseFieldConfig>;
  /** Whether the org has allow_base_field_input_customization enabled — when false, base fields always render as plain default columns regardless of stored input_type/label overrides, matching BaseExpenseFieldInput's own featureEnabled gate. */
  baseFieldCustomizationEnabled: boolean;
  categoryAssignments: CategoryTemplateAssignment[];
  branchGroups: BranchColumnGroup[];
}

const RESERVED_SHEET_CHARS = /[[\]:*?/\\]/g;

function sanitizeSheetName(raw: string, usedNames: Set<string>): string {
  let base = raw.replace(RESERVED_SHEET_CHARS, " ").trim().slice(0, 28) || "Options";
  let name = base;
  let n = 2;
  while (usedNames.has(name.toLowerCase())) {
    name = `${base} ${n}`.slice(0, 31);
    n += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

/** Adds a veryHidden reference sheet + a real Excel dropdown (data validation) on colLetter for every data row. */
function addDropdownColumn(
  workbook: import("exceljs").Workbook,
  sheet: import("exceljs").Worksheet,
  colLetter: string,
  options: string[],
  sheetNameHint: string,
  usedSheetNames: Set<string>,
  lastDataRow: number,
  errorTitle: string,
): void {
  if (options.length === 0 || lastDataRow < 2) return;
  const sheetName = sanitizeSheetName(sheetNameHint, usedSheetNames);
  const refSheet = workbook.addWorksheet(sheetName, { state: "veryHidden" });
  options.forEach((v, i) => { refSheet.getCell(i + 1, 1).value = v; });
  const formula = `'${sheetName}'!$A$1:$A$${options.length}`;
  for (let row = 2; row <= lastDataRow; row++) {
    sheet.getCell(`${colLetter}${row}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle,
      error: "Pick a value from the dropdown list.",
    };
  }
}

type ColumnDef = { header: string; key: string; width: number };

/**
 * Builds the workbook and returns it as a Blob ready to download.
 *
 * Every employee row is pre-filled with their name and identifier — Employee
 * ID when they have one, and Email always. The expense-detail columns are
 * left blank for the admin to fill in.
 */
export async function generateBulkExpenseExcelTemplate(
  employees: OrganizationUserRow[],
  categories: string[],
  fieldConfig: BulkTemplateFieldConfig,
): Promise<Blob> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PesoWise";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Expenses", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const { baseFieldConfig, baseFieldCustomizationEnabled, categoryAssignments, branchGroups } = fieldConfig;
  const bf = (key: BaseExpenseFieldKey): BaseFieldConfig => baseFieldConfig[key];

  // Fixed columns first (Employee identity is always present, unaffected by
  // org config), then base expense fields IN THE SAME ORDER the original
  // static template used — skipping any the org has hidden — then dynamic
  // Field:/Branch: columns. Column POSITIONS are computed here, not
  // hardcoded, because a hidden base field shifts every column after it.
  const columns: ColumnDef[] = [
    { header: BULK_TEMPLATE_HEADERS[0], key: "name", width: 26 },
    { header: BULK_TEMPLATE_HEADERS[1], key: "employeeId", width: 14 },
    { header: BULK_TEMPLATE_HEADERS[2], key: "email", width: 30 },
  ];

  const titleVisible = bf("title").is_visible;
  if (titleVisible) columns.push({ header: `${bf("title").label}${bf("title").is_required ? " (required)" : ""}`, key: "title", width: 26 });

  const destVisible = bf("destination").is_visible;
  if (destVisible) columns.push({ header: `${bf("destination").label}${bf("destination").is_required ? " (required)" : ""}`, key: "destination", width: 26 });

  // Date always present — trip_start/trip_end are NOT NULL on the expenses
  // table regardless of the base field's is_visible setting.
  columns.push({ header: `${bf("expense_date").label} (DD-MM-YYYY)${bf("expense_date").is_required ? " (required)" : ""}`, key: "date", width: 20 });

  const catVisible = bf("category").is_visible;
  if (catVisible) columns.push({ header: `${bf("category").label}${bf("category").is_required ? " (required)" : ""}`, key: "category", width: 24 });

  const amountVisible = bf("amount").is_visible;
  if (amountVisible) columns.push({ header: `${bf("amount").label}${bf("amount").is_required ? " (required)" : ""}`, key: "amount", width: 14 });

  const purposeVisible = bf("purpose").is_visible;
  if (purposeVisible) columns.push({ header: `${bf("purpose").label}${bf("purpose").is_required ? " (required)" : ""}`, key: "purpose", width: 30 });

  // One column per distinct template assigned to >=1 active category.
  const templateCategories = new Map<string, string[]>();
  const templateById = new Map<string, CategoryTemplateAssignment["template"]>();
  const templateRequired = new Map<string, boolean>();
  for (const a of categoryAssignments) {
    templateById.set(a.template.id, a.template);
    const list = templateCategories.get(a.template.id) ?? [];
    list.push(a.categoryName);
    templateCategories.set(a.template.id, list);
    const isRequired = a.requiredOverride !== null ? a.requiredOverride : a.template.required;
    templateRequired.set(a.template.id, (templateRequired.get(a.template.id) ?? false) || isRequired);
  }
  const totalCategoryCount = categories.length;
  const fieldColumnKeys: string[] = [];
  let fieldIdx = 0;
  for (const [templateId, cats] of templateCategories) {
    const template = templateById.get(templateId)!;
    const key = `field_${fieldIdx++}`;
    fieldColumnKeys.push(key);
    const appliesNote = cats.length >= totalCategoryCount ? "" : ` (for: ${cats.join(", ")})`;
    const requiredNote = templateRequired.get(templateId) ? " (required when applicable)" : "";
    columns.push({ header: `Field: ${template.name}${appliesNote}${requiredNote}`, key, width: 24 });
  }

  const branchColumnKeys: string[] = [];
  let branchIdx = 0;
  for (const group of branchGroups) {
    const key = `branch_${branchIdx++}`;
    branchColumnKeys.push(key);
    const requiredNote = group.required ? " (required when applicable — see Reference sheet)" : " (see Reference sheet)";
    columns.push({ header: `${branchColumnHeader(group)}${requiredNote}`, key, width: 24 });
  }

  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };

  const sorted = [...employees].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  for (const emp of sorted) {
    const row: Record<string, string> = {
      name: emp.name || "",
      employeeId: emp.employee_id || "",
      email: emp.email || "",
      date: "",
    };
    if (titleVisible) row.title = "";
    if (destVisible) row.destination = "";
    if (catVisible) row.category = "";
    if (amountVisible) row.amount = "";
    if (purposeVisible) row.purpose = "";
    for (const k of fieldColumnKeys) row[k] = "";
    for (const k of branchColumnKeys) row[k] = "";
    sheet.addRow(row);
  }

  const lastDataRow = sorted.length + 1;
  const usedSheetNames = new Set<string>();

  // Category dropdown — always present when the org has any categories,
  // regardless of base-field customization (Category itself is not an
  // input_type-overridable field; it's always a picklist).
  if (catVisible && categories.length > 0) {
    const colLetter = sheet.getColumn("category").letter;
    addDropdownColumn(workbook, sheet, colLetter, categories, "Categories", usedSheetNames, lastDataRow, "Invalid category");
  }

  // Base-field dropdown override (e.g. MicroLink's "Customer / Site Location", 2,930 options).
  if (destVisible && baseFieldCustomizationEnabled && bf("destination").input_type === "dropdown" && bf("destination").options.length > 0) {
    const colLetter = sheet.getColumn("destination").letter;
    addDropdownColumn(workbook, sheet, colLetter, bf("destination").options, bf("destination").label || "Destination", usedSheetNames, lastDataRow, `Invalid ${bf("destination").label}`);
  }
  if (titleVisible && baseFieldCustomizationEnabled && bf("title").input_type === "dropdown" && bf("title").options.length > 0) {
    const colLetter = sheet.getColumn("title").letter;
    addDropdownColumn(workbook, sheet, colLetter, bf("title").options, bf("title").label || "Title", usedSheetNames, lastDataRow, `Invalid ${bf("title").label}`);
  }
  if (purposeVisible && baseFieldCustomizationEnabled && bf("purpose").input_type === "dropdown" && bf("purpose").options.length > 0) {
    const colLetter = sheet.getColumn("purpose").letter;
    addDropdownColumn(workbook, sheet, colLetter, bf("purpose").options, bf("purpose").label || "Purpose", usedSheetNames, lastDataRow, `Invalid ${bf("purpose").label}`);
  }

  // Template select-type fields get a real dropdown too.
  let fi = 0;
  for (const templateId of templateCategories.keys()) {
    const template = templateById.get(templateId)!;
    const key = fieldColumnKeys[fi++];
    if (template.field_type === "select" && template.options && template.options.length > 0) {
      const colLetter = sheet.getColumn(key).letter;
      addDropdownColumn(workbook, sheet, colLetter, template.options, template.name, usedSheetNames, lastDataRow, `Invalid ${template.name}`);
    }
  }

  // Reference sheet for branch (conditional) fields — visible, not hidden,
  // so an admin filling the sheet can find it and Ctrl+F their parent value.
  if (branchGroups.length > 0) {
    const refSheet = workbook.addWorksheet("Reference");
    refSheet.columns = [
      { header: "Depends on field", key: "parent", width: 28 },
      { header: "When that field is...", key: "parentValue", width: 22 },
      { header: "This branch field", key: "branchName", width: 24 },
      { header: "Valid value(s)", key: "validValues", width: 40 },
    ];
    refSheet.getRow(1).font = { bold: true };
    for (const group of branchGroups) {
      const parentTemplate = templateById.get(group.parentTemplateId);
      for (const r of [...group.rows].sort((a, b) => a.parentOptionValue.localeCompare(b.parentOptionValue))) {
        refSheet.addRow({
          parent: parentTemplate?.name ?? group.parentTemplateName,
          parentValue: r.parentOptionValue,
          branchName: group.name,
          validValues: r.options && r.options.length > 0 ? r.options.join(" | ") : (r.defaultValue ? `default: ${r.defaultValue}` : "(any text)"),
        });
      }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
