import * as XLSX from "xlsx";
import {
  DAILY_PROJECT_REPORT_HEADERS,
  DAILY_REPORT_COST_COLUMNS,
  type DailyProjectExpenseReportRow,
  type DailyProjectReportHeader,
} from "@/lib/dailyExpenseReportConfig";

const AMOUNT_HEADERS = new Set<string>(
  DAILY_REPORT_COST_COLUMNS.map((column) => column.label),
);

/** DOC-113 follow-up. Shown instead of a plain blank cell so a genuinely
 * checked-and-empty value in the exported file is never confused with an
 * ordinary blank. */
const NO_DATA_MARKER = "N/A - no data on record";
const AMBIGUOUS_MARKER = "Ambiguous - multiple names on record, unresolved";

export function dailyReportRowsToSheetAoa(
  rows: DailyProjectExpenseReportRow[],
  ambiguousProjectIds: Set<string> = new Set(),
): (string | number)[][] {
  const headerRow: string[] = [...DAILY_PROJECT_REPORT_HEADERS];
  const dataRows = rows.map((row) => {
    const projectId = String(row["project id"] ?? "").trim();
    return DAILY_PROJECT_REPORT_HEADERS.map((header) =>
      cellValueForExport(header, row[header], projectId, ambiguousProjectIds),
    );
  });
  return [headerRow, ...dataRows];
}

function cellValueForExport(
  header: DailyProjectReportHeader,
  value: string | number | undefined,
  rowProjectId: string,
  ambiguousProjectIds: Set<string>,
): string | number {
  if (header === "percent") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return "";
  }
  if (AMOUNT_HEADERS.has(header)) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return "";
  }
  const stringValue = value === null || value === undefined ? "" : String(value).trim();
  if (stringValue !== "") return stringValue;

  if (header === "project id") return NO_DATA_MARKER;
  if (header === "project name") {
    return rowProjectId && ambiguousProjectIds.has(rowProjectId) ? AMBIGUOUS_MARKER : NO_DATA_MARKER;
  }
  return "";
}

function columnWidth(header: DailyProjectReportHeader): number {
  if (AMOUNT_HEADERS.has(header)) return 14;
  if (header === "Location" || header === "project name" || header === "Remarks") return 24;
  if (header === "Employee") return 20;
  return 16;
}

function escapeCsvValue(value: string | number): string {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function downloadDailyProjectExpenseReportFile(options: {
  rows: DailyProjectExpenseReportRow[];
  dateFrom?: string | null;
  dateTo?: string | null;
  format: "csv" | "xlsx";
  ambiguousProjectIds?: Set<string>;
}): void {
  const { rows, dateFrom, dateTo, format, ambiguousProjectIds } = options;
  const baseName =
    dateFrom && dateTo
      ? `daily-project-expense-report-${dateFrom}-to-${dateTo}`
      : "daily-project-expense-report-all-time";
  const aoa = dailyReportRowsToSheetAoa(rows, ambiguousProjectIds);

  if (format === "csv") {
    const lines = aoa.map((row) => row.map(escapeCsvValue).join(","));
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    return;
  }

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  worksheet["!cols"] = DAILY_PROJECT_REPORT_HEADERS.map((header) => ({
    wch: columnWidth(header),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Daily Project Report");
  XLSX.writeFile(workbook, `${baseName}.xlsx`, { bookType: "xlsx", compression: true });
}
