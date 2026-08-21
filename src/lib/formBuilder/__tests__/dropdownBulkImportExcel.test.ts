import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  readWorkbookFromArrayBuffer,
  isSupportedSpreadsheetExtension,
  isExcelExtension,
} from "@/lib/formBuilder/dropdownBulkImportExcel";

function buildWorkbookArrayBuffer(sheets: Record<string, (string | number)[][]>): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, name);
  }
  const out = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return out;
}

describe("readWorkbookFromArrayBuffer", () => {
  it("reads a single-sheet workbook into a normalized string table", async () => {
    const buffer = buildWorkbookArrayBuffer({
      Sheet1: [
        ["Project Unique ID", "Project ID", "Project Name"],
        ["UID-001", "P-101", "Alpha Tower"],
        ["UID-002", "P-201", "Beta Plaza"],
      ],
    });
    const wb = await readWorkbookFromArrayBuffer(buffer);
    expect(wb.sheetNames).toEqual(["Sheet1"]);
    const rows = wb.getSheetRows("Sheet1");
    expect(rows).toEqual([
      ["Project Unique ID", "Project ID", "Project Name"],
      ["UID-001", "P-101", "Alpha Tower"],
      ["UID-002", "P-201", "Beta Plaza"],
    ]);
  });

  it("lists all sheet names for a multi-sheet workbook and reads each independently", async () => {
    const buffer = buildWorkbookArrayBuffer({
      Cities: [["Ahmedabad"], ["Mumbai"]],
      Projects: [
        ["Parent", "ID"],
        ["U1", "P-1"],
      ],
    });
    const wb = await readWorkbookFromArrayBuffer(buffer);
    expect(wb.sheetNames).toEqual(["Cities", "Projects"]);
    expect(wb.getSheetRows("Cities")).toEqual([["Ahmedabad"], ["Mumbai"]]);
    expect(wb.getSheetRows("Projects")).toEqual([
      ["Parent", "ID"],
      ["U1", "P-1"],
    ]);
  });

  it("returns an empty array for an empty sheet", async () => {
    const buffer = buildWorkbookArrayBuffer({ Empty: [] });
    const wb = await readWorkbookFromArrayBuffer(buffer);
    expect(wb.getSheetRows("Empty")).toEqual([]);
  });

  it("returns an empty array for an unknown sheet name", async () => {
    const buffer = buildWorkbookArrayBuffer({ Sheet1: [["a"]] });
    const wb = await readWorkbookFromArrayBuffer(buffer);
    expect(wb.getSheetRows("DoesNotExist")).toEqual([]);
  });

  it("converts blank cells to empty strings rather than dropping them", async () => {
    const buffer = buildWorkbookArrayBuffer({
      Sheet1: [
        ["Parent", "A", "B"],
        ["U1", "", "x"],
      ],
    });
    const wb = await readWorkbookFromArrayBuffer(buffer);
    const rows = wb.getSheetRows("Sheet1");
    expect(rows).toEqual([
      ["Parent", "A", "B"],
      ["U1", "", "x"],
    ]);
  });

  it("formats numeric cells as display strings, not raw numbers", async () => {
    const buffer = buildWorkbookArrayBuffer({
      Sheet1: [
        ["Parent", "Count"],
        ["U1", 42],
      ],
    });
    const wb = await readWorkbookFromArrayBuffer(buffer);
    const rows = wb.getSheetRows("Sheet1");
    expect(rows[1]).toEqual(["U1", "42"]);
    expect(typeof rows[1][1]).toBe("string");
  });
});

describe("extension helpers", () => {
  it("accepts every supported extension", () => {
    for (const name of ["data.csv", "data.tsv", "data.txt", "data.xlsx", "data.xls", "DATA.XLSX"]) {
      expect(isSupportedSpreadsheetExtension(name)).toBe(true);
    }
  });

  it("rejects unsupported extensions", () => {
    for (const name of ["data.pdf", "data.docx", "data"]) {
      expect(isSupportedSpreadsheetExtension(name)).toBe(false);
    }
  });

  it("identifies excel extensions specifically", () => {
    expect(isExcelExtension("data.xlsx")).toBe(true);
    expect(isExcelExtension("data.xls")).toBe(true);
    expect(isExcelExtension("data.csv")).toBe(false);
  });
});
