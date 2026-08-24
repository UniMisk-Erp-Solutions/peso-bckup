/**
 * DOC-108 — per-organization, pre-filled bulk-import Excel template.
 *
 * Deliberately takes only `employees` and `categories` as plain arrays — it
 * has no concept of "organization" and does no fetching of its own. Every
 * safety guarantee against mixing two organizations' employee data comes
 * from the caller: AdminSubmitExpense.tsx passes the same `employees` and
 * `categories` state it already loaded via fetchOrganizationUsers(organizationId)
 * for the employee picker on this same page — a single, already-scoped
 * source of truth, not a new query surface that could drift out of sync.
 *
 * The `xlsx` package already used elsewhere in this codebase can only READ
 * Excel data validation, not write it (confirmed against the installed
 * 0.18.5 build — no writer path emits <dataValidation>, only the parser
 * consumes it). `exceljs` is added specifically for this: a real,
 * clickable dropdown on the Category column when the file is opened in
 * Excel, not a comment or a note asking the admin to type it correctly.
 */
import type { OrganizationUserRow } from "@/lib/orgUsers";

export const BULK_TEMPLATE_HEADERS = [
  "Employee Name", "Employee ID", "Employee Email",
  "Title", "Destination", "Date (DD-MM-YYYY)", "Category", "Amount", "Purpose",
] as const;

/**
 * Builds the workbook and returns it as a Blob ready to download.
 *
 * Every employee row is pre-filled with their name and identifier — Employee
 * ID when they have one, and Email always (so a row is never left with no
 * working identifier, and rows for employees without an Employee ID are
 * still importable by email alone). The expense-specific columns are left
 * blank for the admin to fill in; Category is a real dropdown pulling from
 * a hidden reference sheet, not free text.
 */
export async function generateBulkExpenseExcelTemplate(
  employees: OrganizationUserRow[],
  categories: string[],
): Promise<Blob> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PesoWise";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Expenses", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: BULK_TEMPLATE_HEADERS[0], key: "name", width: 26 },
    { header: BULK_TEMPLATE_HEADERS[1], key: "employeeId", width: 14 },
    { header: BULK_TEMPLATE_HEADERS[2], key: "email", width: 30 },
    { header: BULK_TEMPLATE_HEADERS[3], key: "title", width: 26 },
    { header: BULK_TEMPLATE_HEADERS[4], key: "destination", width: 22 },
    { header: BULK_TEMPLATE_HEADERS[5], key: "date", width: 18 },
    { header: BULK_TEMPLATE_HEADERS[6], key: "category", width: 22 },
    { header: BULK_TEMPLATE_HEADERS[7], key: "amount", width: 14 },
    { header: BULK_TEMPLATE_HEADERS[8], key: "purpose", width: 30 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };

  const sorted = [...employees].sort((a, b) =>
    (a.name || a.email).localeCompare(b.name || b.email),
  );
  for (const emp of sorted) {
    sheet.addRow({
      name: emp.name || "",
      employeeId: emp.employee_id || "",
      email: emp.email || "",
      title: "", destination: "", date: "", category: "", amount: "", purpose: "",
    });
  }

  // Category dropdown: a real Excel data-validation list, not free text.
  // References a hidden sheet rather than an inline formula so it works
  // regardless of how many categories the organization has — an inline list
  // in Excel's formula1 is capped at ~255 characters.
  if (categories.length > 0) {
    const refSheet = workbook.addWorksheet("Categories", { state: "veryHidden" });
    categories.forEach((c, i) => { refSheet.getCell(i + 1, 1).value = c; });
    const lastRow = categories.length;
    const formula = `Categories!$A$1:$A$${lastRow}`;

    const lastDataRow = sorted.length + 1; // +1 for header row
    for (let row = 2; row <= lastDataRow; row++) {
      sheet.getCell(`G${row}`).dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: [formula],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Invalid category",
        error: "Pick a category from the dropdown list.",
      };
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
