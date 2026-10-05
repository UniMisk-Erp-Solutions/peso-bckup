import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  computeTallyReconciliation,
  parseTallyDebitCell,
  parseTallyGroupSummaryWorkbook,
  parseTallyParticulars,
  parseTallyPeriodText,
  parseTallySignedBalance,
  reconciles,
  resolveTallyEffectiveDate,
  type TallyParseResult,
} from "@/lib/tallyBalanceImport";

/** Locates a fixture's closing-balance cell via the real parser's own row
 * detection (sourceRowNumber), rather than a hardcoded row index -- exactly
 * the "no hardcoded row numbers" discipline this parser itself is built to. */
function closingCellForRow(wb: XLSX.WorkBook, employeeId: string): XLSX.CellObject | undefined {
  const parsed = parseTallyGroupSummaryWorkbook(wb);
  if (parsed.ok === false) throw new Error(`fixture did not parse: ${parsed.reason}`);
  const row = parsed.rows.find((r) => r.employeeId === employeeId);
  if (!row) throw new Error(`employee ${employeeId} not found in parsed fixture`);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // Closing balance is always the rightmost column in these fixtures (column E / index 4).
  return sheet[XLSX.utils.encode_cell({ r: row.sourceRowNumber - 1, c: 4 })];
}

// Tally Group Summary import (2026-08-25). These fixtures reproduce the
// STRUCTURE of the owner's real "Pm july.xlsx" export as described in the
// task spec -- company header rows, "Group Summary" title, a period line, a
// three-row split table header (Particulars | Opening/Transactions/Closing |
// Balance/Debit/Credit/Balance), employee rows, and a Grand Total
// terminator. These synthetic fixtures (no real employee data) are this
// unit-test file's own verification; the owner's real export was
// additionally parsed read-only outside this test suite on 2026-08-26 (see
// Documentations MD/tally-group-summary-balance-import.md's test plan) --
// never committed here, since committing real employee financial data is
// forbidden regardless of how it was verified.

type FixtureClosing = { value: number; side: "cr" | "dr" } | { raw: string };

interface FixtureRow {
  particulars: string;
  closing?: FixtureClosing;
  /** Column C -- Transactions Debit. A plain number (no Cr/Dr marking, unlike closing), or raw text to simulate a malformed cell. */
  debit?: number | { raw: string };
}

function isRaw(c: FixtureClosing): c is { raw: string } {
  return "raw" in c;
}

function buildTallyFixture(opts: {
  headerRowOffset?: number; // extra blank/company rows before the table (tests no-hardcoded-row-detection)
  employeeRows: FixtureRow[];
  grandTotal?: FixtureClosing;
  period?: string;
  splitHeader?: boolean; // true = "Closing" / "Balance" on two stacked rows (realistic Tally shape)
}): XLSX.WorkBook {
  const offset = opts.headerRowOffset ?? 0;
  const aoa: (string | number | null)[][] = [];

  aoa.push(["MicroLink Systems Pvt Ltd", null, null, null, null]);
  aoa.push(["Group Summary", null, null, null, null]);
  aoa.push([opts.period ?? "1-Jul-26 to 31-Jul-26", null, null, null, null]);
  for (let i = 0; i < offset; i++) aoa.push([null, null, null, null, null]);

  if (opts.splitHeader) {
    aoa.push(["Particulars", null, null, null, null]);
    aoa.push([null, "Opening", "Transactions", "Transactions", "Closing"]);
    aoa.push([null, "Balance", "Debit", "Credit", "Balance"]);
  } else {
    aoa.push(["Particulars", "Opening Balance", "Transactions Debit", "Transactions Credit", "Closing Balance"]);
  }

  for (const row of opts.employeeRows) {
    const cellValue = !row.closing ? null : isRaw(row.closing) ? row.closing.raw : row.closing.value;
    const debitValue =
      row.debit === undefined ? null : typeof row.debit === "number" ? row.debit : row.debit.raw;
    aoa.push([row.particulars, null, debitValue, null, cellValue]);
  }
  if (opts.grandTotal) {
    const cellValue = isRaw(opts.grandTotal) ? opts.grandTotal.raw : opts.grandTotal.value;
    aoa.push(["Grand Total", null, null, null, cellValue]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const closingCol = 4; // column E, 0-indexed
  opts.employeeRows.forEach((row, idx) => {
    if (!row.closing || isRaw(row.closing)) return; // raw values get no Cr/Dr number-format assignment
    const rowIdx = aoa.length - opts.employeeRows.length - (opts.grandTotal ? 1 : 0) + idx;
    const ref = XLSX.utils.encode_cell({ r: rowIdx, c: closingCol });
    ws[ref].z = row.closing.side === "cr" ? '0.00 "Cr"' : '0.00 "Dr"';
  });
  if (opts.grandTotal && !isRaw(opts.grandTotal)) {
    const rowIdx = aoa.length - 1;
    const ref = XLSX.utils.encode_cell({ r: rowIdx, c: closingCol });
    ws[ref].z = opts.grandTotal.side === "cr" ? '0.00 "Cr"' : '0.00 "Dr"';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  // Round-trip through a real xlsx buffer, exactly like a browser File
  // upload would, so the parser is tested against genuine SheetJS read
  // behavior (cellNF/cellText), not an in-memory-only worksheet shape.
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return XLSX.read(buf, { type: "buffer", cellNF: true, cellText: true });
}

const SAMPLE_ROWS: FixtureRow[] = [
  { particulars: "Test Employee Alpha-6849", closing: { value: 9845, side: "cr" } },
  { particulars: "Test Employee Beta-6349", closing: { value: 13981, side: "dr" } },
  { particulars: "Test Employee Gamma-6669" }, // blank closing
  { particulars: "Test Employee Delta - 6919", closing: { value: 100, side: "dr" } },
  { particulars: "Test Employee Epsilon  - 6808", closing: { value: 50, side: "cr" } },
  { particulars: "Test Employee Zeta-6876-Hold", closing: { value: 200, side: "dr" } },
];

function expectOk(result: TallyParseResult): asserts result is Extract<TallyParseResult, { ok: true }> {
  if (result.ok === false) throw new Error(`expected ok:true, got failure: ${result.reason}`);
}

describe("parseTallySignedBalance -- Cr/Dr sign is in the cell format, not the raw number", () => {
  it("Cr -> negative", () => {
    const wb = buildTallyFixture({ employeeRows: [{ particulars: "X-1", closing: { value: 9845, side: "cr" } }] });
    const cell = closingCellForRow(wb, "1");
    expect(cell?.v).toBe(9845); // raw value is POSITIVE even though it's a Cr balance
    expect(parseTallySignedBalance(cell)).toEqual({ magnitude: 9845, side: "cr", signedBalance: -9845 });
  });

  it("Dr -> positive", () => {
    const wb = buildTallyFixture({ employeeRows: [{ particulars: "X-1", closing: { value: 13981, side: "dr" } }] });
    const cell = closingCellForRow(wb, "1");
    expect(parseTallySignedBalance(cell)).toEqual({ magnitude: 13981, side: "dr", signedBalance: 13981 });
  });

  it("blank -> zero, not null/skipped", () => {
    expect(parseTallySignedBalance(undefined)).toEqual({ magnitude: 0, side: "zero", signedBalance: 0 });
  });

  it("never infers sign from the raw positive number alone", () => {
    const wb = buildTallyFixture({
      employeeRows: [
        { particulars: "A-1", closing: { value: 500, side: "cr" } },
        { particulars: "B-2", closing: { value: 500, side: "dr" } },
      ],
    });
    const crCell = closingCellForRow(wb, "1");
    const drCell = closingCellForRow(wb, "2");
    expect(crCell?.v).toBe(drCell?.v); // identical raw numbers
    expect(parseTallySignedBalance(crCell).signedBalance).toBe(-500);
    expect(parseTallySignedBalance(drCell).signedBalance).toBe(500);
  });
});

describe("parseTallySignedBalance -- a non-numeric non-blank value must never become ₹0", () => {
  it("undefined cell -> zero", () => {
    expect(parseTallySignedBalance(undefined)).toEqual({ magnitude: 0, side: "zero", signedBalance: 0 });
  });

  it("null cell -> zero", () => {
    expect(parseTallySignedBalance(null)).toEqual({ magnitude: 0, side: "zero", signedBalance: 0 });
  });

  it("empty string cell -> zero", () => {
    expect(parseTallySignedBalance({ v: "", t: "s" })).toEqual({ magnitude: 0, side: "zero", signedBalance: 0 });
  });

  it("whitespace-only string cell -> zero", () => {
    expect(parseTallySignedBalance({ v: "   ", t: "s" })).toEqual({ magnitude: 0, side: "zero", signedBalance: 0 });
  });

  it("numeric zero -> zero", () => {
    expect(parseTallySignedBalance({ v: 0, t: "n" })).toEqual({ magnitude: 0, side: "zero", signedBalance: 0 });
  });

  it('"ABC" -> invalid, never coerced to zero via Math.abs(Number(x)) || 0', () => {
    const result = parseTallySignedBalance({ v: "ABC", t: "s" });
    expect(Number.isNaN(result.signedBalance)).toBe(true);
    expect(result.signedBalance).not.toBe(0);
  });

  it('"N/A" -> invalid', () => {
    const result = parseTallySignedBalance({ v: "N/A", t: "s" });
    expect(Number.isNaN(result.signedBalance)).toBe(true);
  });

  it('a bare "-" -> invalid, not zero', () => {
    const result = parseTallySignedBalance({ v: "-", t: "s" });
    expect(Number.isNaN(result.signedBalance)).toBe(true);
  });

  it("a non-zero number with neither Cr nor Dr marking -> invalid (ambiguous sign)", () => {
    const result = parseTallySignedBalance({ v: 500, t: "n" });
    expect(Number.isNaN(result.signedBalance)).toBe(true);
  });

  it("Cr -> negative (control case, still passes with the new numeric-validity check)", () => {
    const result = parseTallySignedBalance({ v: 500, t: "n", w: '500.00 "Cr"', z: '0.00 "Cr"' });
    expect(result).toEqual({ magnitude: 500, side: "cr", signedBalance: -500 });
  });

  it("Dr -> positive (control case)", () => {
    const result = parseTallySignedBalance({ v: 500, t: "n", w: '500.00 "Dr"', z: '0.00 "Dr"' });
    expect(result).toEqual({ magnitude: 500, side: "dr", signedBalance: 500 });
  });
});

describe("parseTallyParticulars -- name + employee ID from one cell, tolerant of real formatting variance", () => {
  it("no spaces around hyphen", () => {
    expect(parseTallyParticulars("Test Employee Gamma-6669")).toEqual({
      employeeName: "Test Employee Gamma",
      employeeId: "6669",
      flags: [],
    });
  });

  it("spaces around hyphen", () => {
    expect(parseTallyParticulars("Test Employee Delta - 6919")).toEqual({
      employeeName: "Test Employee Delta",
      employeeId: "6919",
      flags: [],
    });
  });

  it("double space before hyphen", () => {
    expect(parseTallyParticulars("Test Employee Epsilon  - 6808")).toEqual({
      employeeName: "Test Employee Epsilon",
      employeeId: "6808",
      flags: [],
    });
  });

  it("-Hold suffix is stripped from the name/ID and recorded as a flag", () => {
    expect(parseTallyParticulars("Test Employee Zeta-6876-Hold")).toEqual({
      employeeName: "Test Employee Zeta",
      employeeId: "6876",
      flags: ["hold"],
    });
  });

  it("employee ID is a string, never coerced through Number()", () => {
    const parsed = parseTallyParticulars("Someone-00123");
    expect(parsed?.employeeId).toBe("00123");
    expect(typeof parsed?.employeeId).toBe("string");
  });

  it("returns null for text with no trailing numeric ID", () => {
    expect(parseTallyParticulars("Grand Total")).toBeNull();
    expect(parseTallyParticulars("Opening Balance")).toBeNull();
  });
});

describe("parseTallyPeriodText", () => {
  it("parses '1-Jul-26 to 31-Jul-26' to ISO dates, not hardcoded to July", () => {
    expect(parseTallyPeriodText("1-Jul-26 to 31-Jul-26")).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
  });

  it("parses a different month correctly", () => {
    expect(parseTallyPeriodText("1-Aug-26 to 31-Aug-26")).toEqual({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });
  });

  it("returns null for unrelated text", () => {
    expect(parseTallyPeriodText("Group Summary")).toBeNull();
  });
});

describe("resolveTallyEffectiveDate -- Case A/B is an explicit caller choice, never inferred silently", () => {
  it("opening_balance -> periodEnd + 1 day", () => {
    expect(resolveTallyEffectiveDate("2026-07-31", "opening_balance")).toBe("2026-08-01");
  });

  it("balance_update -> periodEnd itself", () => {
    expect(resolveTallyEffectiveDate("2026-07-31", "balance_update")).toBe("2026-07-31");
  });

  it("handles month rollover correctly", () => {
    expect(resolveTallyEffectiveDate("2026-02-28", "opening_balance")).toBe("2026-03-01");
  });

  it("handles year rollover correctly (Dec 31 -> Jan 1 of the NEXT year)", () => {
    expect(resolveTallyEffectiveDate("2026-12-31", "opening_balance")).toBe("2027-01-01");
  });

  it("handles a real leap day correctly (2028-02-29 -> 2028-03-01, not skipped or doubled)", () => {
    expect(resolveTallyEffectiveDate("2028-02-29", "opening_balance")).toBe("2028-03-01");
  });

  it("year rollover leaves Balance Update's effective date untouched (it's periodEnd itself, no arithmetic)", () => {
    expect(resolveTallyEffectiveDate("2026-12-31", "balance_update")).toBe("2026-12-31");
  });

  it("is UTC-safe: does not depend on the local timezone the test runs in", () => {
    // If this used local-timezone Date arithmetic (e.g. `new Date("2026-12-31")`
    // then `.setDate(d.getDate()+1)`), a negative-UTC-offset timezone could
    // roll the calendar date backwards by one before the +1 day is even
    // applied. Constructing via Date.UTC(y, m-1, d+1) and reading back via
    // getUTC* methods (as resolveTallyEffectiveDate does) sidesteps this
    // entirely -- this test simply pins the exact boundary value so a
    // regression to local-time arithmetic would be caught immediately.
    expect(resolveTallyEffectiveDate("2026-12-31", "opening_balance")).toBe("2027-01-01");
    expect(resolveTallyEffectiveDate("2028-02-29", "opening_balance")).toBe("2028-03-01");
  });
});

describe("parseTallyGroupSummaryWorkbook -- end to end", () => {
  it("parses the full sample: names/IDs, Cr negative, Dr positive, blank zero, Grand Total reconciles", () => {
    // signed sum = -9845 (Cr) + 13981 (Dr) + 0 (blank) + 100 (Dr) - 50 (Cr) + 200 (Dr) = 4386
    const signedSum = -9845 + 13981 + 0 + 100 - 50 + 200;
    const wb = buildTallyFixture({
      employeeRows: SAMPLE_ROWS,
      grandTotal: { value: Math.abs(signedSum), side: signedSum < 0 ? "cr" : "dr" },
    });

    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.periodStart).toBe("2026-07-01");
    expect(result.periodEnd).toBe("2026-07-31");
    expect(result.unidentifiedRows).toEqual([]);
    expect(result.amountFailures).toEqual([]);
    expect(result.rows).toHaveLength(6);

    const byId = new Map(result.rows.map((r) => [r.employeeId, r]));
    expect(byId.get("6849")).toMatchObject({ employeeName: "Test Employee Alpha", signedClosingBalance: -9845 });
    expect(byId.get("6349")).toMatchObject({ employeeName: "Test Employee Beta", signedClosingBalance: 13981 });
    expect(byId.get("6669")).toMatchObject({ employeeName: "Test Employee Gamma", signedClosingBalance: 0 });
    expect(byId.get("6919")).toMatchObject({ employeeName: "Test Employee Delta", signedClosingBalance: 100 });
    expect(byId.get("6808")).toMatchObject({ employeeName: "Test Employee Epsilon", signedClosingBalance: -50 });
    expect(byId.get("6876")).toMatchObject({ employeeName: "Test Employee Zeta", signedClosingBalance: 200, flags: ["hold"] });

    expect(result.sheetFinancialTotal).toBe(signedSum);
    expect(result.reportGrandTotal).toBe(signedSum);
    expect(result.sheetReconciliationDifference).toBe(0);
    expect(reconciles(result)).toBe(true);
  });

  it("does not import Grand Total as an employee row", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1, side: "dr" } }],
      grandTotal: { value: 1, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.rows.some((r) => /grand total/i.test(r.rawParticulars))).toBe(false);
    expect(result.rows).toHaveLength(1);
  });

  it("flags a reconciliation mismatch instead of hiding it", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1000, side: "dr" } }],
      grandTotal: { value: 999, side: "dr" }, // deliberately wrong
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.sheetReconciliationDifference).toBe(1);
    expect(reconciles(result)).toBe(false);
  });

  it("does not falsely flag a mismatch within the ₹0.01 tolerance", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1000, side: "dr" } }],
      grandTotal: { value: 1000.005, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(reconciles(result)).toBe(true);
  });

  it("detects the table even when pushed down by extra header/address rows (no hardcoded row numbers)", () => {
    const wb = buildTallyFixture({
      headerRowOffset: 12,
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1, side: "dr" } }],
      grandTotal: { value: 1, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].employeeId).toBe("100");
  });

  it("detects the table against the REAL owner file's exact quirks: two-line company/report header and a stray bare number in column A", () => {
    // Reproduces the real "Pm july.xlsx" shape reported by the owner:
    // "Microlink Solutions Private Limited" / "Advance Given to Employee -
    // Programme Management" as two separate header lines (not one), plus a
    // stray bare "10" in column A above the table -- neither should ever be
    // mistaken for the Particulars header or an employee row.
    const aoa: (string | number | null)[][] = [
      ["Microlink Solutions Private Limited", null, null, null, null],
      ["Advance Given to Employee - Programme Management", null, null, null, null],
      ["Group Summary", null, null, null, null],
      ["1-Jul-26 to 31-Jul-26", null, null, null, null],
      [10, null, null, null, null], // stray bare number, not a header/data row
      ["Particulars", null, null, null, null],
      [null, "Opening", "Transactions", "Transactions", "Closing"],
      [null, "Balance", "Debit", "Credit", "Balance"],
      ["Test Employee Gamma-6669", null, null, null, null],
      ["Test Employee Alpha-6849", null, null, null, 9845],
      ["Grand Total", null, null, null, 9845],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws[XLSX.utils.encode_cell({ r: 9, c: 4 })].z = '0.00 "Cr"';
    ws[XLSX.utils.encode_cell({ r: 10, c: 4 })].z = '0.00 "Cr"';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const wbRead = XLSX.read(buf, { type: "buffer", cellNF: true, cellText: true });

    const result = parseTallyGroupSummaryWorkbook(wbRead);
    expectOk(result);
    expect(result.periodStart).toBe("2026-07-01");
    expect(result.periodEnd).toBe("2026-07-31");
    expect(result.rows).toHaveLength(2);
    expect(result.unidentifiedRows).toEqual([]);
    expect(result.amountFailures).toEqual([]);
    const byId = new Map(result.rows.map((r) => [r.employeeId, r]));
    expect(byId.get("6669")?.signedClosingBalance).toBe(0); // blank closing
    expect(byId.get("6849")?.signedClosingBalance).toBe(-9845); // Cr
    expect(reconciles(result)).toBe(true);
  });

  it("detects a realistic split header (Closing / Balance on two stacked rows)", () => {
    const wb = buildTallyFixture({
      splitHeader: true,
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1, side: "dr" } }],
      grandTotal: { value: 1, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.rows).toHaveLength(1);
  });

  it("rejects an unsupported file shape without guessing", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Name", "Amount"],
      ["Someone", 100],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const result = parseTallyGroupSummaryWorkbook(wb);
    expect(result.ok).toBe(false);
  });

  it("reports a row-level identity failure for unparseable Particulars instead of silently dropping it -- and its KNOWN amount still counts toward sheetFinancialTotal", () => {
    const wb = buildTallyFixture({
      employeeRows: [
        { particulars: "No numeric id here", closing: { value: 1, side: "dr" } },
        { particulars: "Someone-100", closing: { value: 1, side: "dr" } },
      ],
      grandTotal: { value: 2, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.rows).toHaveLength(1);
    expect(result.unidentifiedRows).toHaveLength(1);
    expect(result.unidentifiedRows[0].rawParticulars).toBe("No numeric id here");
    expect(result.unidentifiedRows[0].signedClosingBalance).toBe(1);
    expect(result.amountFailures).toEqual([]);
    // Both rows' amounts count: sheetFinancialTotal = 1 (identified) + 1 (unidentified) = 2, matching Grand Total.
    expect(result.sheetFinancialTotal).toBe(2);
    expect(reconciles(result)).toBe(true);
  });

  it("an identity failure whose Grand Total does NOT include its amount correctly fails reconciliation (the sheet itself, not identity, decides pass/fail)", () => {
    const wb = buildTallyFixture({
      employeeRows: [
        { particulars: "No numeric id here", closing: { value: 1, side: "dr" } },
        { particulars: "Someone-100", closing: { value: 1, side: "dr" } },
      ],
      grandTotal: { value: 1, side: "dr" }, // Grand Total omits the unidentified row's amount
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.sheetFinancialTotal).toBe(2);
    expect(result.reportGrandTotal).toBe(1);
    expect(reconciles(result)).toBe(false);
  });

  it("this is the exact reproduction of the ₹15,903 production bug: Kairavi Bhatt - Trainee's known Cr balance must not vanish from the sheet total", () => {
    const wb = buildTallyFixture({
      employeeRows: [
        { particulars: "Kairavi Bhatt - Trainee", closing: { value: 15903, side: "cr" } },
        { particulars: "Shailesh Barot Late. Punjiram-3673", closing: { value: 1780, side: "cr" } },
      ],
      // Tally's own Grand Total includes BOTH rows: -(15903 + 1780) = -17683
      grandTotal: { value: 17683, side: "cr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.rows).toHaveLength(1); // only the identified row
    expect(result.unidentifiedRows).toHaveLength(1);
    expect(result.unidentifiedRows[0].signedClosingBalance).toBe(-15903);
    // The old buggy `parsedClosingTotal` would have been -1780 here (only
    // the identified row) -- a ₹15,903 gap against the -17683 Grand Total,
    // exactly the production incident. The fixed sheetFinancialTotal
    // includes both rows and reconciles exactly.
    expect(result.sheetFinancialTotal).toBe(-17683);
    expect(result.sheetReconciliationDifference).toBe(0);
    expect(reconciles(result)).toBe(true);
  });

  it("a row whose amount itself cannot be read is NEVER silently folded into sheetFinancialTotal as ₹0, identity notwithstanding", () => {
    const wb = buildTallyFixture({
      employeeRows: [
        { particulars: "Someone-100", closing: { raw: "N/A" } },
        { particulars: "Someone Else-200", closing: { value: 500, side: "dr" } },
      ],
      grandTotal: { value: 500, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.rows).toHaveLength(1);
    expect(result.amountFailures).toHaveLength(1);
    expect(result.amountFailures[0]).toMatchObject({ employeeId: "100", employeeName: "Someone" });
    expect(result.sheetFinancialTotal).toBe(500); // excludes the unreadable row entirely
    // Even though the numbers happen to match here, an amount failure fails closed.
    expect(reconciles(result)).toBe(false);
  });

  it("rejects a file with zero successfully parsed employee rows", () => {
    const wb = buildTallyFixture({
      employeeRows: [],
      grandTotal: { value: 0, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expect(result.ok).toBe(false);
    if (result.ok === true) throw new Error("expected ok:false");
    expect(result.reason).toMatch(/no employee rows/i);
  });

  it("rejects a file where every row failed to parse (zero usable rows, not zero attempted)", () => {
    const wb = buildTallyFixture({
      employeeRows: [
        { particulars: "Not a valid row", closing: { value: 1, side: "dr" } },
        { particulars: "Also not valid", closing: { value: 1, side: "dr" } },
      ],
      grandTotal: { value: 2, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expect(result.ok).toBe(false);
    if (result.ok === true) throw new Error("expected ok:false");
    expect(result.reason).toMatch(/no employee rows/i);
    expect(result.reason).toMatch(/2 row/i);
  });
});

describe("Grand Total is REQUIRED -- fails closed, never proceeds without a real reconciliation check", () => {
  it("missing Grand Total row entirely -> parses, but reconciles() is false (import cannot continue)", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1000, side: "dr" } }],
      // no grandTotal at all
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.reportGrandTotal).toBeNull();
    expect(reconciles(result)).toBe(false);
  });

  it("Grand Total closing cell is non-numeric/ambiguous -> reportGrandTotal null, reconciles() false", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1000, side: "dr" } }],
      grandTotal: { raw: "N/A" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.reportGrandTotal).toBeNull();
    expect(reconciles(result)).toBe(false);
  });

  it("exact reconciliation (difference = 0) -> passes", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1000, side: "dr" } }],
      grandTotal: { value: 1000, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.sheetReconciliationDifference).toBe(0);
    expect(reconciles(result)).toBe(true);
  });

  it("within the ₹0.01 tolerance -> passes", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1000, side: "dr" } }],
      grandTotal: { value: 1000.005, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(reconciles(result)).toBe(true);
  });

  it("more than ₹0.01 off -> fails", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Someone-100", closing: { value: 1000, side: "dr" } }],
      grandTotal: { value: 998, side: "dr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(reconciles(result)).toBe(false);
  });
});

describe("computeTallyReconciliation -- identity resolution is separate from, and never affects, sheet-level reconciliation", () => {
  function buildScenario() {
    // Matched(1) + name-mismatch(1) + unknown-employee(1) + identity-unparseable(1).
    const wb = buildTallyFixture({
      employeeRows: [
        { particulars: "Matched Person-1001", closing: { value: 100, side: "dr" } },
        { particulars: "Tally Name Variant-1002", closing: { value: 200, side: "dr" } },
        { particulars: "Ghost Employee-9999", closing: { value: 300, side: "cr" } },
        { particulars: "No Numeric Id Here", closing: { value: 50, side: "cr" } },
      ],
      // Grand Total sums ALL four rows: 100 + 200 - 300 - 50 = -50
      grandTotal: { value: 50, side: "cr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    const employeesById = {
      "1001": { name: "Matched Person" },
      "1002": { name: "PesoWise Recorded Name" }, // differs from Tally's "Tally Name Variant"
    };
    return { result, employeesById };
  }

  it("1. exact match -> importable", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    expect(summary.matchedCount).toBe(1);
  });

  it("2. same Employee ID, different name -> importable (Employee ID authoritative)", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    expect(summary.nameMismatchCount).toBe(1);
    expect(summary.importableRows.some((r) => r.row.employeeId === "1002" && r.status === "name_mismatch")).toBe(
      true,
    );
  });

  it("3. unknown Employee ID -> skipped, never staged", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    expect(summary.unknownEmployeeCount).toBe(1);
    expect(summary.unknownEmployeeRows[0].row.employeeId).toBe("9999");
    expect(summary.importableRows.some((r) => r.row.employeeId === "9999")).toBe(false);
  });

  it("4. no numeric Employee ID -> skipped, never staged", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    expect(summary.identityFailureCount).toBe(1);
  });

  it("5 & 6. identity-only problems (unknown employee, unparseable identity) still participate in sheet reconciliation", () => {
    const { result } = buildScenario();
    expect(result.sheetFinancialTotal).toBe(-50); // 100 + 200 - 300 - 50
    expect(reconciles(result)).toBe(true);
  });

  it("7. importableTotal + skippedKnownTotal == sheetFinancialTotal", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    expect(summary.importSumMatchesSheetTotal).toBe(true);
    expect(summary.importableTotal + summary.skippedKnownTotal).toBeCloseTo(summary.sheetFinancialTotal, 2);
  });

  it("8. sheetFinancialTotal == Grand Total -> reconciliation PASSES even with skipped employees", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    expect(summary.sheetReconciles).toBe(true);
    expect(summary.unknownEmployeeCount + summary.identityFailureCount).toBeGreaterThan(0);
  });

  it("9. a genuine unexplained arithmetic mismatch still FAILS, identity notwithstanding", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Matched Person-1001", closing: { value: 100, side: "dr" } }],
      grandTotal: { value: 999, side: "dr" }, // wrong
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    const summary = computeTallyReconciliation(result, { "1001": { name: "Matched Person" } });
    expect(summary.sheetReconciles).toBe(false);
  });

  it("22. every importable row is either matched or name-mismatch, never unknown", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    expect(summary.importableRows.every((r) => r.status === "matched" || r.status === "name_mismatch")).toBe(true);
  });

  it("24 & 25. staging set is exactly importableRows -- unknown/unidentified never included", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    const stagedIds = summary.importableRows.map((r) => r.row.employeeId);
    expect(stagedIds.sort()).toEqual(["1001", "1002"]);
    expect(stagedIds).not.toContain("9999");
  });

  it("26. name mismatch resolution uses Employee ID as identity, never the Tally name", () => {
    const { result, employeesById } = buildScenario();
    const summary = computeTallyReconciliation(result, employeesById);
    const mismatch = summary.importableRows.find((r) => r.status === "name_mismatch");
    expect(mismatch?.row.employeeId).toBe("1002");
    expect(mismatch?.pesoWiseName).toBe("PesoWise Recorded Name");
    expect(mismatch?.row.employeeName).toBe("Tally Name Variant"); // Tally's own text, display-only
  });
});

describe("Phase 16 regression fixture -- reproduces the observed 'service july.xlsx' scenario shape", () => {
  // 64 identifiable employee rows (15 Cr / 11 Dr / 38 zero) plus the three
  // specific real-world cases reported: a name mismatch (3673), an unknown
  // employee (4114), and an unparseable Particulars row ("Kairavi Bhatt -
  // Trainee"). Amounts here are synthetic -- the real file's amounts are
  // never hardcoded into runtime logic or committed to this repo.
  function buildRegressionFixture() {
    const rows: FixtureRow[] = [];
    for (let i = 0; i < 15; i++) rows.push({ particulars: `Cr Employee ${i}-${5000 + i}`, closing: { value: 100 + i, side: "cr" } });
    for (let i = 0; i < 11; i++) rows.push({ particulars: `Dr Employee ${i}-${5100 + i}`, closing: { value: 50 + i, side: "dr" } });
    for (let i = 0; i < 38; i++) rows.push({ particulars: `Zero Employee ${i}-${5200 + i}` }); // blank closing
    rows.push({ particulars: "Shailesh Barot Late. Punjiram-3673", closing: { value: 1780, side: "cr" } });
    rows.push({ particulars: "Sharanabasappa-4114" }); // blank closing, unknown employee
    rows.push({ particulars: "Kairavi Bhatt - Trainee", closing: { value: 15903, side: "cr" } });

    const signedSum = rows.reduce((sum, r) => {
      if (!r.closing || isRaw(r.closing)) return sum;
      return sum + (r.closing.side === "cr" ? -r.closing.value : r.closing.value);
    }, 0);

    const wb = buildTallyFixture({
      employeeRows: rows,
      grandTotal: { value: Math.abs(signedSum), side: signedSum < 0 ? "cr" : "dr" },
    });
    return { wb, signedSum };
  }

  it("66 identifiable rows (15 Cr + 11 Dr + 38 zero + 3673 + 4114) + 1 unidentifiable row (Kairavi), matching the observed shape", () => {
    const { wb } = buildRegressionFixture();
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.rows).toHaveLength(66);
    expect(result.unidentifiedRows).toHaveLength(1);
    expect(result.unidentifiedRows[0].rawParticulars).toBe("Kairavi Bhatt - Trainee");
    expect(result.amountFailures).toEqual([]);
  });

  it("sheetFinancialTotal reconciles exactly against the Grand Total, including Kairavi Bhatt's amount", () => {
    const { wb, signedSum } = buildRegressionFixture();
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.sheetFinancialTotal).toBe(signedSum);
    expect(reconciles(result)).toBe(true);
  });

  it("employee 3673 (name mismatch) and 4114 (unknown) resolve correctly and never block Continue-equivalent reconciles()", () => {
    const { wb } = buildRegressionFixture();
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    const employeesById: Record<string, { name: string }> = { "3673": { name: "Shaileshkumar Barot" } };
    for (let i = 0; i < 15; i++) employeesById[String(5000 + i)] = { name: `Cr Employee ${i}` };
    for (let i = 0; i < 11; i++) employeesById[String(5100 + i)] = { name: `Dr Employee ${i}` };
    for (let i = 0; i < 38; i++) employeesById[String(5200 + i)] = { name: `Zero Employee ${i}` };
    // 4114 intentionally omitted -> unknown employee.

    const summary = computeTallyReconciliation(result, employeesById);
    expect(summary.sheetReconciles).toBe(true);
    expect(summary.unknownEmployeeCount).toBe(1);
    expect(summary.unknownEmployeeRows[0].row.employeeId).toBe("4114");
    expect(summary.nameMismatchCount).toBe(1);
    const mismatch3673 = summary.importableRows.find((r) => r.row.employeeId === "3673");
    expect(mismatch3673?.status).toBe("name_mismatch");
    expect(mismatch3673?.pesoWiseName).toBe("Shaileshkumar Barot");
    expect(summary.identityFailureCount).toBe(1); // Kairavi Bhatt
    expect(summary.importSumMatchesSheetTotal).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tally Balance Update hotfix (2026-10-01): Balance Update must add ONLY
// the Debit column amount, never Closing Balance, never Closing-minus-
// Opening, never Debit-minus-Credit. These tests use the task spec's own
// worked example throughout: Opening 10,000 / Debit 5,000 / Credit 3,000 /
// Closing 12,000 -- Balance Update must add exactly 5,000.
// ─────────────────────────────────────────────────────────────────────────
describe("parseTallyDebitCell -- the Balance Update amount source", () => {
  it("a valid positive Debit returns that exact amount", () => {
    expect(parseTallyDebitCell({ t: "n", v: 5000 } as XLSX.CellObject)).toBe(5000);
  });

  it("blank Debit -> 0 (no balance addition), not a failure", () => {
    expect(parseTallyDebitCell(undefined)).toBe(0);
    expect(parseTallyDebitCell(null)).toBe(0);
  });

  it("zero Debit -> 0 (no balance addition)", () => {
    expect(parseTallyDebitCell({ t: "n", v: 0 } as XLSX.CellObject)).toBe(0);
  });

  it("negative Debit -> NaN (Tally's own Group Summary format never produces one; fail closed rather than invent a meaning)", () => {
    expect(parseTallyDebitCell({ t: "n", v: -500 } as XLSX.CellObject)).toBeNaN();
  });

  it("unparseable text -> NaN, never silently 0", () => {
    expect(parseTallyDebitCell({ t: "s", v: "N/A" } as XLSX.CellObject)).toBeNaN();
  });

  it("tolerates thousands-separator commas", () => {
    expect(parseTallyDebitCell({ t: "s", v: "5,000" } as XLSX.CellObject)).toBe(5000);
  });
});

describe("parseTallyGroupSummaryWorkbook -- tallyDebitAmount end-to-end (the task's own worked example)", () => {
  it("Opening 10,000 / Debit 5,000 / Credit 3,000 / Closing 12,000 -> tallyDebitAmount is exactly 5,000, independent of Closing", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Test Employee-9001", closing: { value: 12000, side: "dr" }, debit: 5000 }],
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    const row = result.rows.find((r) => r.employeeId === "9001");
    expect(row?.tallyDebitAmount).toBe(5000);
    expect(row?.signedClosingBalance).toBe(12000); // Closing Balance is still parsed/available, just not used for Balance Update's addition
  });

  it("Debit 5,000 but Closing 50,000 -> tallyDebitAmount is STILL exactly 5,000 (proves Closing Balance is no longer accidentally used)", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Test Employee-9002", closing: { value: 50000, side: "dr" }, debit: 5000 }],
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    const row = result.rows.find((r) => r.employeeId === "9002");
    expect(row?.tallyDebitAmount).toBe(5000);
  });

  it("blank Debit cell -> tallyDebitAmount 0 for that row", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Test Employee-9003", closing: { value: 1000, side: "cr" } }], // no debit set
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    const row = result.rows.find((r) => r.employeeId === "9003");
    expect(row?.tallyDebitAmount).toBe(0);
  });

  it("zero Debit cell -> tallyDebitAmount 0 for that row", () => {
    const wb = buildTallyFixture({
      employeeRows: [{ particulars: "Test Employee-9004", closing: { value: 1000, side: "cr" }, debit: 0 }],
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    const row = result.rows.find((r) => r.employeeId === "9004");
    expect(row?.tallyDebitAmount).toBe(0);
  });

  it("unparseable Debit text -> tallyDebitAmount is NaN, never silently 0, and never affects sheet-level reconciliation (which is Closing-Balance-only)", () => {
    const wb = buildTallyFixture({
      employeeRows: [
        { particulars: "Test Employee-9005", closing: { value: 1000, side: "cr" }, debit: { raw: "ABC" } },
      ],
      grandTotal: { value: 1000, side: "cr" },
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    const row = result.rows.find((r) => r.employeeId === "9005");
    expect(row?.tallyDebitAmount).toBeNaN();
    // Sheet-level reconciliation is unaffected -- it is defined purely in
    // terms of Closing Balance, which this row's cell still reads fine.
    expect(reconciles(result)).toBe(true);
  });

  it("works with the realistic split header (Opening/Transactions-Debit/Transactions-Credit/Closing across two stacked rows)", () => {
    const wb = buildTallyFixture({
      splitHeader: true,
      employeeRows: [{ particulars: "Test Employee-9006", closing: { value: 12000, side: "dr" }, debit: 5000 }],
    });
    const result = parseTallyGroupSummaryWorkbook(wb);
    expectOk(result);
    expect(result.rows.find((r) => r.employeeId === "9006")?.tallyDebitAmount).toBe(5000);
  });
});
