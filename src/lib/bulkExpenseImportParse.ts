/**
 * DOC-108 — parsing for the bulk admin-submit-on-behalf-of-employee import.
 *
 * Reuses the two spreadsheet readers this codebase already has, rather than
 * writing a third: `parseTabularText` (CSV/TSV, RFC4180-ish, quote and
 * embedded-newline aware) for text files, `readWorkbookFromArrayBuffer`
 * (dynamic `xlsx` import) for .xlsx/.xls. Both already return the same
 * `string[][]` shape, so this file only adds the column-header mapping and
 * row validation specific to this import.
 */
import { parseTabularText } from "@/lib/formBuilder/dropdownBulkImport";
import { readWorkbookFromArrayBuffer, isExcelExtension } from "@/lib/formBuilder/dropdownBulkImportExcel";

/** Hard ceiling protecting the browser (table rendering), not a backend limit. */
export const MAX_BULK_IMPORT_ROWS = 5000;
/** Rows per admin_bulk_submit_expenses_v1 call — server rejects above 250. */
export const BULK_SUBMIT_CHUNK_SIZE = 200;

export interface BulkExpenseRow {
  rowIndex: number; // 1-based spreadsheet row, header excluded (row 1 = first data row)
  employeeId: string;
  email: string;
  title: string;
  destination: string;
  expenseDate: string; // YYYY-MM-DD, unvalidated at this stage
  category: string;
  amount: string; // unparsed — validated in validateBulkRows
  purpose: string;
  issues: string[]; // client-side validation problems; empty = ready to submit
}

export interface BulkExpenseParseResult {
  rows: BulkExpenseRow[];
  unmappedHeaders: string[];
  missingColumns: string[];
}

const HEADER_ALIASES: Record<string, keyof Omit<BulkExpenseRow, "rowIndex" | "issues">> = {
  "employee id": "employeeId",
  "employee_id": "employeeId",
  "emp id": "employeeId",
  "emp_id": "employeeId",
  "employee code": "employeeId",
  "email": "email",
  "employee email": "email",
  "title": "title",
  "expense title": "title",
  "destination": "destination",
  "vendor": "destination",
  "vendor / location": "destination",
  "location": "destination",
  "date": "expenseDate",
  "expense date": "expenseDate",
  "category": "category",
  "expense type": "category",
  "amount": "amount",
  "expense amount": "amount",
  "purpose": "purpose",
  "description": "purpose",
  "notes": "purpose",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isSupportedBulkImportExtension(fileName: string): boolean {
  return /\.(csv|txt|xlsx|xls)$/i.test(fileName);
}

async function readRows(file: File): Promise<string[][]> {
  if (isExcelExtension(file.name)) {
    const buffer = await file.arrayBuffer();
    const workbook = await readWorkbookFromArrayBuffer(buffer);
    const firstSheet = workbook.sheetNames[0];
    return firstSheet ? workbook.getSheetRows(firstSheet) : [];
  }
  const text = await file.text();
  return parseTabularText(text);
}

/**
 * Reads the file and maps columns by header — no validation of cell values
 * yet (that's `validateBulkRows`, run separately so the UI can show a
 * per-row issue list rather than a single all-or-nothing parse failure).
 */
export async function parseBulkExpenseFile(file: File): Promise<BulkExpenseParseResult> {
  const allRows = await readRows(file);
  if (allRows.length === 0) {
    return { rows: [], unmappedHeaders: [], missingColumns: ["employee_id or email", "title", "destination", "date", "category", "amount"] };
  }

  const [headerRow, ...dataRows] = allRows;
  const columnMap: (keyof Omit<BulkExpenseRow, "rowIndex" | "issues"> | null)[] = headerRow.map(
    (h) => HEADER_ALIASES[normalizeHeader(h)] ?? null,
  );
  const unmappedHeaders = headerRow.filter((_, i) => columnMap[i] === null && headerRow[i].trim() !== "");

  const mappedFields = new Set(columnMap.filter(Boolean));
  const missingColumns: string[] = [];
  if (!mappedFields.has("employeeId") && !mappedFields.has("email")) {
    missingColumns.push("Employee ID or Email");
  }
  for (const [field, label] of [
    ["title", "Title"], ["destination", "Destination"], ["expenseDate", "Date"],
    ["category", "Category"], ["amount", "Amount"],
  ] as const) {
    if (!mappedFields.has(field)) missingColumns.push(label);
  }

  const capped = dataRows.slice(0, MAX_BULK_IMPORT_ROWS);
  const rows: BulkExpenseRow[] = capped.map((cells, i) => {
    const row: BulkExpenseRow = {
      rowIndex: i + 1,
      employeeId: "", email: "", title: "", destination: "",
      expenseDate: "", category: "", amount: "", purpose: "",
      issues: [],
    };
    columnMap.forEach((field, colIdx) => {
      if (field) (row[field] as string) = (cells[colIdx] ?? "").trim();
    });
    return row;
  });

  return { rows: validateBulkRows(rows), unmappedHeaders, missingColumns };
}

/** Row-level validation — mirrors what the server will reject, so problems surface before any RPC call. */
export function validateBulkRows(rows: BulkExpenseRow[]): BulkExpenseRow[] {
  return rows.map((row) => {
    const issues: string[] = [];
    if (!row.employeeId && !row.email) issues.push("Missing Employee ID or Email");
    if (!row.title) issues.push("Missing Title");
    if (!row.destination) issues.push("Missing Destination");
    if (!row.expenseDate) issues.push("Missing Date");
    else if (!DATE_RE.test(row.expenseDate)) issues.push("Date must be YYYY-MM-DD");
    if (!row.category) issues.push("Missing Category");
    const amountNum = Number(row.amount);
    if (!row.amount) issues.push("Missing Amount");
    else if (!Number.isFinite(amountNum) || amountNum <= 0) issues.push("Amount must be a number greater than 0");
    return { ...row, issues };
  });
}
