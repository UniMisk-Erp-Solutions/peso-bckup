/**
 * Excel (.xlsx / .xls) reading for the dropdown bulk-import dialog.
 *
 * Split out from dropdownBulkImport.ts so the pure CSV/TSV engine never pulls
 * in the `xlsx` package (already a project dependency — no new one added).
 * `xlsx` is dynamically imported here so it stays out of the editor's initial
 * bundle and is only fetched when a user actually picks an Excel file.
 */

export type WorkbookPreview = {
  sheetNames: string[];
  getSheetRows: (sheetName: string) => string[][];
};

export async function readWorkbookFromArrayBuffer(buffer: ArrayBuffer): Promise<WorkbookPreview> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetNames = workbook.SheetNames;

  return {
    sheetNames,
    getSheetRows(sheetName: string): string[][] {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) return [];
      const rows = XLSX.utils.sheet_to_json<string[]>(worksheet, {
        header: 1,
        raw: false,
        defval: "",
      });
      // sheet_to_json can return non-string cell values for some formats even
      // with raw:false (e.g. formula errors); coerce defensively and drop
      // wholly-blank rows, mirroring parseDelimitedText's behaviour.
      return rows
        .map((row) => (Array.isArray(row) ? row.map((c) => (c === null || c === undefined ? "" : String(c))) : []))
        .filter((row) => row.some((c) => c.trim() !== ""));
    },
  };
}

export function isSupportedSpreadsheetExtension(fileName: string): boolean {
  return /\.(csv|tsv|txt|xlsx|xls)$/i.test(fileName);
}

export function isExcelExtension(fileName: string): boolean {
  return /\.(xlsx|xls)$/i.test(fileName);
}
