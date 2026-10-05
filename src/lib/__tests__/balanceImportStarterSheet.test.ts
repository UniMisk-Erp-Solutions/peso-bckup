import { describe, expect, it } from "vitest";
import {
  buildStagedRowsFromSheet,
  canonicalStarterHeaders,
  excelCellToIsoDate,
  resolveStarterSheetSchema,
  type ParsedSheet,
} from "@/lib/balanceImportStarterSheet";

// Owner-reported bugfix (2026-08-24). See ImportBalancesDialog.tsx's header
// comment for the two defects these tests exist to pin down:
//   Bug A -- an Excel date serial (e.g. 46204 for 2026-07-01) was sent to
//            Postgres as the literal string "46204", which a `date` column
//            rejects ("invalid input syntax for type date").
//   Bug B -- the old mapping auto-guess regex matched BOTH "Current Balance"
//            and "Opening Balance" to "amount", so Current Balance could
//            silently become the imported amount instead of Opening Balance.

describe("excelCellToIsoDate", () => {
  it("converts the Excel serial from the owner's report to the correct calendar date", () => {
    expect(excelCellToIsoDate(46204)).toEqual({ ok: true, iso: "2026-07-01" });
  });

  it("converts a JS Date value to the same calendar date, without a timezone shift", () => {
    const d = new Date(Date.UTC(2026, 6, 1)); // month is 0-based: 6 = July
    expect(excelCellToIsoDate(d)).toEqual({ ok: true, iso: "2026-07-01" });
  });

  it("passes through an ISO date string unchanged", () => {
    expect(excelCellToIsoDate("2026-07-01")).toEqual({ ok: true, iso: "2026-07-01" });
  });

  it("returns null (not an error) for a blank cell", () => {
    expect(excelCellToIsoDate(null)).toEqual({ ok: true, iso: null });
    expect(excelCellToIsoDate(undefined)).toEqual({ ok: true, iso: null });
    expect(excelCellToIsoDate("")).toEqual({ ok: true, iso: null });
    expect(excelCellToIsoDate("   ")).toEqual({ ok: true, iso: null });
  });

  it("fails an invalid non-blank value rather than passing it through", () => {
    expect(excelCellToIsoDate("not a date")).toEqual({ ok: false });
    expect(excelCellToIsoDate("2026-13-40")).toEqual({ ok: false });
    expect(excelCellToIsoDate(NaN)).toEqual({ ok: false });
  });

  it("never returns a raw numeric-serial string for a numeric input", () => {
    const result = excelCellToIsoDate(46204);
    expect(result.ok && result.iso).not.toBe("46204");
    expect(result.ok && result.iso).toBe("2026-07-01");
  });

  it("handles a leap-year date serial correctly (2028-02-29)", () => {
    // Excel serial for 2028-02-29 (days since the epoch SheetJS uses).
    const serial = Math.round(
      (Date.UTC(2028, 1, 29) - Date.UTC(1899, 11, 30)) / 86400000,
    );
    expect(excelCellToIsoDate(serial)).toEqual({ ok: true, iso: "2028-02-29" });
  });

  it("handles a month-end date serial correctly (2026-07-31)", () => {
    const serial = Math.round(
      (Date.UTC(2026, 6, 31) - Date.UTC(1899, 11, 30)) / 86400000,
    );
    expect(excelCellToIsoDate(serial)).toEqual({ ok: true, iso: "2026-07-31" });
  });

  it("rejects a bare numeric string that does not decode to a valid calendar date", () => {
    expect(excelCellToIsoDate("99999999")).toEqual({ ok: false });
  });
});

describe("resolveStarterSheetSchema", () => {
  it("resolves the canonical historical_opening layout and never maps Current Balance to amount", () => {
    const headers = canonicalStarterHeaders("historical_opening");
    const result = resolveStarterSheetSchema(headers, "historical_opening");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.amountIndex).toBe(headers.indexOf("Opening Balance"));
    expect(result.schema.currentBalanceIndex).toBe(headers.indexOf("Current Balance"));
    expect(result.schema.amountIndex).not.toBe(result.schema.currentBalanceIndex);
  });

  it("resolves the canonical balance_update layout and never maps Current Balance to amount", () => {
    const headers = canonicalStarterHeaders("balance_update");
    const result = resolveStarterSheetSchema(headers, "balance_update");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.amountIndex).toBe(headers.indexOf("Balance Update"));
    expect(result.schema.currentBalanceIndex).toBe(headers.indexOf("Current Balance"));
    expect(result.schema.amountIndex).not.toBe(result.schema.currentBalanceIndex);
  });

  it("resolves the canonical allocation layout and never maps Current Balance to amount", () => {
    const headers = canonicalStarterHeaders("allocation");
    const result = resolveStarterSheetSchema(headers, "allocation");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.amountIndex).toBe(headers.indexOf("Allocation Amount"));
    expect(result.schema.currentBalanceIndex).toBe(headers.indexOf("Current Balance"));
    expect(result.schema.amountIndex).not.toBe(result.schema.currentBalanceIndex);
  });

  it("is trim + case-insensitive on header text", () => {
    const headers = [
      "  employee id ",
      "EMPLOYEE NAME",
      "Email",
      "current balance",
      "Opening Balance",
      "effective DATE",
      "note",
    ];
    const result = resolveStarterSheetSchema(headers, "historical_opening");
    expect(result.ok).toBe(true);
  });

  it("reports every missing canonical column when the file does not match the starter sheet", () => {
    const result = resolveStarterSheetSchema(["Employee ID", "Email"], "historical_opening");
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.missing).toEqual(
      expect.arrayContaining(["Employee Name", "Current Balance", "Opening Balance", "Effective Date", "Note"]),
    );
  });

  it("fails when the sheet has the wrong amount column for the selected mode", () => {
    // An allocation-mode sheet uploaded while historical_opening is selected.
    const headers = canonicalStarterHeaders("allocation");
    const result = resolveStarterSheetSchema(headers, "historical_opening");
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.missing).toContain("Opening Balance");
  });

  it("ignores a harmless extra column rather than blocking the import", () => {
    const headers = [...canonicalStarterHeaders("historical_opening"), "Department"];
    const result = resolveStarterSheetSchema(headers, "historical_opening");
    expect(result.ok).toBe(true);
  });
});

describe("buildStagedRowsFromSheet -- the owner's real workbook shape", () => {
  const headers = canonicalStarterHeaders("historical_opening");
  const schemaResult = resolveStarterSheetSchema(headers, "historical_opening");
  if (!schemaResult.ok) throw new Error("canonical schema must resolve");
  const schema = schemaResult.schema;

  it("stages Opening Balance as the amount, never Current Balance, with the date correctly normalized", () => {
    const parsedSheet: ParsedSheet = {
      headers,
      rows: [["1001", "Admin User", "admin@mistryandshah.com", -927882.94, 927882.94, 46204, "updated balances"]],
    };
    const { rows, invalidDateRows } = buildStagedRowsFromSheet(parsedSheet, schema);
    expect(invalidDateRows).toEqual([]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.rawEmployeeId).toBe("1001");
    expect(row.rawEmail).toBe("admin@mistryandshah.com");
    expect(row.inputAmount).toBe(927882.94);
    expect(row.inputAmount).not.toBe(-927882.94);
    expect(row.effectiveDate).toBe("2026-07-01");
    expect(row.note).toBe("updated balances");
  });

  it("keeps a leading-zero Employee ID as a string, never coerced through Number()", () => {
    const parsedSheet: ParsedSheet = {
      headers,
      rows: [["000123", "Someone", "someone@mistryandshah.com", 0, 100, null, null]],
    };
    const { rows } = buildStagedRowsFromSheet(parsedSheet, schema);
    expect(rows[0].rawEmployeeId).toBe("000123");
  });

  it("falls back to Email identity when Employee ID is blank", () => {
    const parsedSheet: ParsedSheet = {
      headers,
      rows: [["", "cashier", "cashier@mistryandshah.com", 2004807, 927882.94, 46204, null]],
    };
    const { rows } = buildStagedRowsFromSheet(parsedSheet, schema);
    const row = rows[0];
    expect(row.rawEmployeeId).toBeNull();
    expect(row.rawEmail).toBe("cashier@mistryandshah.com");
    expect(row.inputAmount).toBe(927882.94);
  });

  it("marks a row with a non-blank, unparseable Effective Date as invalid instead of staging it", () => {
    const parsedSheet: ParsedSheet = {
      headers,
      rows: [["1002", "Someone", "s@x.com", 0, 500, "not a date", null]],
    };
    const { rows, invalidDateRows } = buildStagedRowsFromSheet(parsedSheet, schema);
    expect(invalidDateRows).toEqual([1]);
    expect(rows[0].effectiveDate).toBeNull();
  });

  it("leaves Effective Date null when the cell is blank", () => {
    const parsedSheet: ParsedSheet = {
      headers,
      rows: [["1003", "Someone", "s2@x.com", 0, 500, null, null]],
    };
    const { rows, invalidDateRows } = buildStagedRowsFromSheet(parsedSheet, schema);
    expect(invalidDateRows).toEqual([]);
    expect(rows[0].effectiveDate).toBeNull();
  });

  it("stages Allocation Amount (not Current Balance) in allocation mode", () => {
    const allocHeaders = canonicalStarterHeaders("allocation");
    const allocSchemaResult = resolveStarterSheetSchema(allocHeaders, "allocation");
    if (!allocSchemaResult.ok) throw new Error("allocation schema must resolve");
    const parsedSheet: ParsedSheet = {
      headers: allocHeaders,
      rows: [["1004", "Someone", "s3@x.com", 50000, 1500, "2026-07-31", null]],
    };
    const { rows } = buildStagedRowsFromSheet(parsedSheet, allocSchemaResult.schema);
    expect(rows[0].inputAmount).toBe(1500);
    expect(rows[0].inputAmount).not.toBe(50000);
  });
});
