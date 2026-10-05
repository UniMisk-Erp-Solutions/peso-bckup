import * as XLSX from "xlsx";

// Tally Group Summary import (2026-08-25). Pure parser -- no React, no
// Supabase. Converts a classic Tally "Group Summary" export directly into
// historical-balance-anchor input, replacing the requirement to transcribe
// Tally data into the PesoWise starter sheet by hand.
//
// This module ONLY parses the file and returns signed target balances. It
// makes NO accounting decisions: whether a row becomes an opening_balance or
// balance_update anchor, and what effective_date that implies, is decided by
// the caller (the wizard, after the admin's explicit choice) -- see
// ImportBalancesDialog.tsx. The parsed signedClosingBalance is used verbatim
// as a Historical Balance Anchor V2 `stated_balance` (a TARGET, never a
// delta) -- balance_apply_import_v2's engine computes the actual
// reconciliation effect server-side, exactly as it does for a PesoWise
// starter-sheet import.
//
// Critical correctness note (why this can't use raw cell values): a Tally
// Closing Balance cell's underlying number (`cell.v`) is always POSITIVE --
// Dr/Cr is carried ONLY in the cell's display format (`cell.z`/`cell.w`,
// e.g. `0.00 "Cr"` / `0.00 "Dr"`), not in the number itself. Reading with
// `sheet_to_json({raw:true})` and calling `Number()` on the result would
// silently treat every Cr balance as positive. This module reads workbook
// cells directly (via XLSX.utils cell refs) and inspects the format/text,
// never `sheet_to_json` for the balance column.

export type TallySide = "dr" | "cr" | "zero";

export interface TallySignedBalance {
  magnitude: number;
  side: TallySide;
  signedBalance: number;
}

/**
 * Reads a single Closing Balance cell's true signed value. Prefers the
 * formatted display text (`cell.w`, what Tally actually shows -- requires
 * reading the workbook with `cellText: true`) and falls back to the raw
 * number-format string (`cell.z`, requires `cellNF: true`) if `w` is
 * unavailable. Never infers sign from `cell.v` alone -- that is always a
 * positive magnitude regardless of Dr/Cr.
 */
export function parseTallySignedBalance(cell: XLSX.CellObject | undefined | null): TallySignedBalance {
  if (!cell || cell.v === undefined || cell.v === null) {
    return { magnitude: 0, side: "zero", signedBalance: 0 };
  }

  const trimmedText = typeof cell.v === "string" ? cell.v.trim() : cell.v;
  if (trimmedText === "") {
    return { magnitude: 0, side: "zero", signedBalance: 0 };
  }

  const numeric = typeof trimmedText === "number" ? trimmedText : Number(trimmedText);
  if (!Number.isFinite(numeric)) {
    // Non-empty, non-blank, but not a real number ("ABC", "N/A", "-", stray
    // text). Must NEVER silently become ₹0 -- `Math.abs(Number(x)) || 0`
    // would do exactly that, since Number("ABC") is NaN and `NaN || 0` is 0.
    // The caller treats a NaN signedBalance as a row-level parse failure.
    return { magnitude: NaN, side: "zero", signedBalance: NaN };
  }

  const magnitude = Math.abs(numeric);
  const formatSource = `${cell.w ?? ""} ${cell.z ?? ""}`;

  const hasCr = /\bcr\b/i.test(formatSource);
  const hasDr = /\bdr\b/i.test(formatSource);

  if (magnitude === 0) {
    return { magnitude: 0, side: "zero", signedBalance: 0 };
  }
  if (hasCr && !hasDr) {
    return { magnitude, side: "cr", signedBalance: round2(-magnitude) };
  }
  if (hasDr && !hasCr) {
    return { magnitude, side: "dr", signedBalance: round2(magnitude) };
  }
  // Ambiguous or unmarked (neither Cr nor Dr token found, or both somehow
  // present): cannot determine sign safely. Caller must treat this as a row
  // failure rather than guessing.
  return { magnitude, side: "zero", signedBalance: NaN };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Reads the Transactions "Debit" cell -- a plain positive amount (unlike
 * Closing Balance, Tally never marks this column's sign with Cr/Dr text).
 * NaN (never a silent 0) signals a genuinely unreadable cell -- stray text,
 * a negative value (Tally's own Group Summary format does not produce a
 * negative Debit; treat one as unexpected rather than inventing a meaning
 * for it), or anything else that is not a recognizable non-negative number.
 * Blank and exactly-zero are both legitimate "no debit this period" and
 * return 0, never NaN -- per the task's own explicit requirement that
 * blank/zero must mean "no balance addition", not a parse failure.
 */
export function parseTallyDebitCell(cell: XLSX.CellObject | undefined | null): number {
  if (!cell || cell.v === undefined || cell.v === null) return 0;
  const raw = typeof cell.v === "string" ? cell.v.trim() : cell.v;
  if (raw === "") return 0;
  const numeric = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return NaN;
  if (numeric < 0) return NaN;
  return round2(numeric);
}

export interface ParsedParticulars {
  employeeName: string;
  employeeId: string;
  flags: string[];
}

const PARTICULARS_RE = /^(.*?)\s*-\s*(\d+)(?:\s*-\s*hold)?\s*$/i;
const HOLD_RE = /-\s*hold\s*$/i;

/**
 * Splits a Tally "Particulars" cell into employee name + employee ID.
 * Tolerates "Name-1234", "Name - 1234", "Name  -  1234" (irregular
 * whitespace around the hyphen), and a trailing "-Hold" marker. Employee ID
 * is always returned as a string -- never coerced through Number()/parseInt,
 * so leading zeros (if Tally ever produces them) survive.
 */
export function parseTallyParticulars(raw: string): ParsedParticulars | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = PARTICULARS_RE.exec(trimmed);
  if (!match) return null;
  const employeeName = match[1].trim();
  const employeeId = match[2];
  if (!employeeName || !employeeId) return null;
  const flags = HOLD_RE.test(trimmed) ? ["hold"] : [];
  return { employeeName, employeeId, flags };
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseTallyDateToken(token: string): string | null {
  const m = /^(\d{1,2})[-\s]([a-z]{3})[-\s](\d{2,4})$/i.exec(token.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const monthKey = m[2].toLowerCase();
  const month = MONTH_INDEX[monthKey];
  if (month === undefined) return null;
  let year = Number(m[3]);
  if (m[3].length === 2) {
    year += year <= 69 ? 2000 : 1900;
  }
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const PERIOD_RE = /(\d{1,2}[-\s][A-Za-z]{3}[-\s]\d{2,4})\s*(?:to|[-–—])\s*(\d{1,2}[-\s][A-Za-z]{3}[-\s]\d{2,4})/i;

export interface TallyPeriod {
  periodStart: string;
  periodEnd: string;
}

/** Extracts a "1-Jul-26 to 31-Jul-26"-shaped period from free text. */
export function parseTallyPeriodText(text: string): TallyPeriod | null {
  const m = PERIOD_RE.exec(text);
  if (!m) return null;
  const periodStart = parseTallyDateToken(m[1]);
  const periodEnd = parseTallyDateToken(m[2]);
  if (!periodStart || !periodEnd) return null;
  return { periodStart, periodEnd };
}

export interface TallyBalanceRow {
  sourceRowNumber: number;
  rawParticulars: string;
  employeeName: string;
  employeeId: string;
  tallyClosingMagnitude: number;
  tallyClosingSide: TallySide;
  signedClosingBalance: number;
  /**
   * Column C -- "how much NEW money was added this period", the ONLY
   * amount a Balance Update import adds to a PesoWise balance (never
   * Closing Balance, never Closing-minus-Opening, never Debit-minus-
   * Credit). 0 for a genuinely blank/zero Debit cell; NaN signals the
   * cell could not be read as a valid amount -- see `parseTallyDebitCell`.
   * Opening Balance imports are unaffected by this field and continue to
   * use `signedClosingBalance`, unchanged.
   */
  tallyDebitAmount: number;
  flags: string[];
}

/**
 * A row whose closing balance amount IS readable, but whose Particulars
 * text could not be split into an employee name + numeric ID (e.g.
 * "Kairavi Bhatt - Trainee"). This is an IDENTITY problem, not a financial
 * one: the amount still counts toward `sheetFinancialTotal` (it is a real
 * balance on the real Tally sheet) even though the row can never be staged
 * against a PesoWise employee. Conflating these two questions -- "can we
 * read the amount" vs "can we import it" -- is exactly what caused the
 * ₹15,903 reconciliation bug this type exists to fix (see
 * Documentations MD/tally-import-warning-reconciliation.md).
 */
export interface TallyUnidentifiedRow {
  sourceRowNumber: number;
  rawParticulars: string;
  tallyClosingMagnitude: number;
  tallyClosingSide: TallySide;
  signedClosingBalance: number;
  reason: string;
}

/**
 * A row whose Closing Balance cell itself could not be read as a valid,
 * signed amount -- regardless of whether identity parsed. NEVER counted in
 * any financial total (never silently coerced to ₹0): the true amount is
 * genuinely unknown, so it is surfaced as its own diagnostic category
 * rather than folded into either `rows` or `unidentifiedRows`.
 */
export interface TallyAmountFailure {
  sourceRowNumber: number;
  rawParticulars: string;
  employeeName: string | null;
  employeeId: string | null;
  reason: string;
}

export type TallyParseResult =
  | {
      ok: true;
      periodStart: string;
      periodEnd: string;
      rows: TallyBalanceRow[];
      unidentifiedRows: TallyUnidentifiedRow[];
      amountFailures: TallyAmountFailure[];
      /** The workbook's own Grand Total Closing Balance, signed. Null if absent/unreadable. */
      reportGrandTotal: number | null;
      /**
       * SUM of every row whose closing balance can be financially parsed --
       * `rows` + `unidentifiedRows` -- regardless of whether employee
       * identity could be resolved. This is deliberately NOT gated on
       * identity: whether a row can be STAGED into PesoWise is a separate
       * question, decided later by employee-identity resolution (see
       * `computeTallyReconciliation`), never by this total.
       */
      sheetFinancialTotal: number;
      sheetReconciliationDifference: number | null;
    }
  | { ok: false; reason: string };

const GRAND_TOTAL_RE = /grand\s*total/i;
const PARTICULARS_HEADER_RE = /^particulars$/i;
const HEADER_SCAN_ROWS = 60;
const HEADER_WINDOW = 4;

function cellText(sheet: XLSX.WorkSheet, r: number, c: number): string {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return "";
  if (cell.w !== undefined) return String(cell.w).trim();
  if (cell.v !== undefined && cell.v !== null) return String(cell.v).trim();
  return "";
}

interface TableLocation {
  particularsColumn: number;
  closingBalanceColumn: number;
  /**
   * The Transactions "Debit" column (Column C in the supported Group
   * Summary format: Particulars | Opening Balance | Debit | Credit |
   * Closing Balance). Required -- a file where this cannot be located
   * fails the parse the same way a missing Closing Balance column already
   * does, rather than silently falling back to Closing Balance for the
   * balance-update amount.
   */
  debitColumn: number;
  firstDataRow: number;
}

function locateTallyTable(sheet: XLSX.WorkSheet, range: XLSX.Range): TableLocation | null {
  const maxRow = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS);

  for (let r = range.s.r; r <= maxRow; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (!PARTICULARS_HEADER_RE.test(cellText(sheet, r, c))) continue;

      const particularsRow = r;
      const particularsColumn = c;

      // Search a small window of rows for a column whose header text
      // (possibly split across two stacked rows, e.g. "Closing" / "Balance")
      // contains BOTH tokens -- this uniquely identifies Closing Balance
      // without matching Opening Balance (has "balance" but not "closing")
      // or Transactions Debit/Credit (has neither).
      let closingBalanceColumn: number | null = null;

      for (let cc = range.s.c; cc <= range.e.c; cc++) {
        let combined = "";
        for (let rr = particularsRow; rr <= Math.min(particularsRow + HEADER_WINDOW, range.e.r); rr++) {
          const t = cellText(sheet, rr, cc);
          if (t) combined += ` ${t}`;
        }
        if (/closing/i.test(combined) && /balance/i.test(combined)) {
          closingBalanceColumn = cc;
          break;
        }
      }

      if (closingBalanceColumn === null) continue;

      // Debit column: combined header text contains "debit" (Column C in
      // the supported layout: Particulars | Opening Balance | Debit |
      // Credit | Closing Balance). Matched independently of the Closing
      // Balance search above -- "debit" never co-occurs with "closing" in
      // this format's headers, so there is no ambiguity between the two.
      let debitColumn: number | null = null;
      for (let cc = range.s.c; cc <= range.e.c; cc++) {
        let combined = "";
        for (let rr = particularsRow; rr <= Math.min(particularsRow + HEADER_WINDOW, range.e.r); rr++) {
          const t = cellText(sheet, rr, cc);
          if (t) combined += ` ${t}`;
        }
        if (/\bdebit\b/i.test(combined)) {
          debitColumn = cc;
          break;
        }
      }

      if (debitColumn === null) continue;

      // The header block's height is NOT inferred from "last non-empty cell
      // in a window" -- every data row also has non-empty cells, which would
      // make that scan swallow real employee rows. Instead: the PARTICULARS
      // column itself is blank on every header continuation row (a split
      // header's sub-label row has no particulars-column text at all) and
      // becomes non-blank again only when real employee data starts. That
      // boundary is exact regardless of how many rows the header spans.
      let firstDataRow = particularsRow + 1;
      while (firstDataRow <= range.e.r && !cellText(sheet, firstDataRow, particularsColumn)) {
        firstDataRow++;
      }

      return {
        particularsColumn,
        closingBalanceColumn,
        debitColumn,
        firstDataRow,
      };
    }
  }

  return null;
}

function findPeriod(sheet: XLSX.WorkSheet, range: XLSX.Range): TallyPeriod | { ambiguous: true } | null {
  const maxRow = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS);
  let found: TallyPeriod | null = null;

  for (let r = range.s.r; r <= maxRow; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const text = cellText(sheet, r, c);
      if (!text) continue;
      const period = parseTallyPeriodText(text);
      if (!period) continue;
      if (found && (found.periodStart !== period.periodStart || found.periodEnd !== period.periodEnd)) {
        return { ambiguous: true };
      }
      found = period;
    }
  }
  return found;
}

/**
 * Top-level parser. Returns `{ok:false}` (never throws) for a file that does
 * not look like a supported Tally Group Summary export -- the wizard shows
 * this as "This doesn't look like a supported Tally Group Summary export."
 * rather than falling back to any column-guessing/mapping UI.
 */
export function parseTallyGroupSummaryWorkbook(workbook: XLSX.WorkBook): TallyParseResult {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { ok: false, reason: "The file has no sheets." };
  const sheet = workbook.Sheets[sheetName];
  const ref = sheet["!ref"];
  if (!ref) return { ok: false, reason: "The sheet appears to be empty." };
  const range = XLSX.utils.decode_range(ref);

  const table = locateTallyTable(sheet, range);
  if (!table) {
    return {
      ok: false,
      reason:
        'Could not find a "Particulars" + "Debit" + "Closing Balance" table. This doesn\'t look like a supported Tally Group Summary export.',
    };
  }

  const period = findPeriod(sheet, range);
  if (!period) {
    return { ok: false, reason: "Could not find the report period (expected a \"<date> to <date>\" line)." };
  }
  if ("ambiguous" in period) {
    return { ok: false, reason: "Found more than one conflicting report period in this file." };
  }

  const rows: TallyBalanceRow[] = [];
  const unidentifiedRows: TallyUnidentifiedRow[] = [];
  const amountFailures: TallyAmountFailure[] = [];
  let reportGrandTotal: number | null = null;
  let sheetFinancialTotal = 0;

  for (let r = table.firstDataRow; r <= range.e.r; r++) {
    const rawParticulars = cellText(sheet, r, table.particularsColumn);
    if (!rawParticulars) continue; // blank separator row

    if (GRAND_TOTAL_RE.test(rawParticulars)) {
      const totalCell = sheet[XLSX.utils.encode_cell({ r, c: table.closingBalanceColumn })];
      const totalBalance = parseTallySignedBalance(totalCell);
      reportGrandTotal = Number.isNaN(totalBalance.signedBalance) ? null : totalBalance.signedBalance;
      break; // Grand Total terminates the employee table.
    }

    // Identity and amount are parsed INDEPENDENTLY -- an identity failure
    // must never suppress an otherwise-readable amount from the sheet's
    // financial total, and vice versa. See TallyUnidentifiedRow's comment.
    const particulars = parseTallyParticulars(rawParticulars);
    const closingCell = sheet[XLSX.utils.encode_cell({ r, c: table.closingBalanceColumn })];
    const closing = parseTallySignedBalance(closingCell);
    const debitCell = sheet[XLSX.utils.encode_cell({ r, c: table.debitColumn })];
    const debitAmount = parseTallyDebitCell(debitCell);

    if (Number.isNaN(closing.signedBalance)) {
      // The amount itself is unreadable. Never counted in any total,
      // regardless of identity -- this is the one case that can leave a
      // genuine, unexplained gap in the sheet's own reconciliation.
      amountFailures.push({
        sourceRowNumber: r + 1,
        rawParticulars,
        employeeName: particulars?.employeeName ?? null,
        employeeId: particulars?.employeeId ?? null,
        reason:
          'Closing Balance could not be read as a valid amount -- it is not blank, not a recognizable number, or not clearly marked Cr or Dr, so the sign cannot be determined safely.',
      });
      continue;
    }

    if (!particulars) {
      // Identity failed, but the amount is real and known -- it still
      // participates in sheet-level reconciliation; only staging is
      // skipped (decided later, by employee-identity resolution).
      unidentifiedRows.push({
        sourceRowNumber: r + 1,
        rawParticulars,
        tallyClosingMagnitude: closing.magnitude,
        tallyClosingSide: closing.side,
        signedClosingBalance: closing.signedBalance,
        reason:
          'Could not extract a numeric Employee ID from this row (expected "Name-1234" or "Name - 1234"). This row will be skipped.',
      });
      sheetFinancialTotal = round2(sheetFinancialTotal + closing.signedBalance);
      continue;
    }

    rows.push({
      sourceRowNumber: r + 1,
      rawParticulars,
      employeeName: particulars.employeeName,
      employeeId: particulars.employeeId,
      tallyClosingMagnitude: closing.magnitude,
      tallyClosingSide: closing.side,
      signedClosingBalance: closing.signedBalance,
      tallyDebitAmount: debitAmount,
      flags: particulars.flags,
    });
    sheetFinancialTotal = round2(sheetFinancialTotal + closing.signedBalance);
  }

  // A structurally-detected table with zero rows that could ever be staged
  // (fully identified AND financially readable) is not usable input --
  // rejected at the parser level so no caller can accidentally treat an
  // empty importable set as a valid import. Amount-known-but-unidentified
  // rows do NOT rescue this: they can never be staged either.
  if (rows.length === 0) {
    const unusable = unidentifiedRows.length + amountFailures.length;
    const failureNote = unusable > 0 ? ` (${unusable} row(s) could not be read)` : "";
    return {
      ok: false,
      reason: `No employee rows could be parsed from this Group Summary export${failureNote}.`,
    };
  }

  const sheetReconciliationDifference =
    reportGrandTotal === null ? null : round2(sheetFinancialTotal - reportGrandTotal);

  return {
    ok: true,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    rows,
    unidentifiedRows,
    amountFailures,
    reportGrandTotal,
    sheetFinancialTotal,
    sheetReconciliationDifference,
  };
}

/** ₹0.01 tolerance for floating-point/rounding noise across ~200+ summed rows. */
export const RECONCILIATION_TOLERANCE = 0.01;

/**
 * FAILS CLOSED: a Tally Group Summary with no Grand Total row (or one whose
 * Closing Balance cell is not clearly marked Cr/Dr) can never reconcile --
 * there is nothing to check the sheet total against, and this is a
 * financial import, not a best-effort one. A row whose amount itself could
 * not be read (`amountFailures`) also fails this check unconditionally:
 * `sheetFinancialTotal` excludes that row's unknown amount by construction,
 * so any apparent match would be coincidental, not proven. This check is
 * deliberately independent of employee identity -- unknown employees, name
 * mismatches, and unparseable Particulars never affect it (see
 * `computeTallyReconciliation` for the identity-aware importable/skipped
 * split used to gate Continue and staging).
 */
export function reconciles(result: Extract<TallyParseResult, { ok: true }>): boolean {
  if (result.amountFailures.length > 0) return false;
  if (result.reportGrandTotal === null || result.sheetReconciliationDifference === null) return false;
  return Math.abs(result.sheetReconciliationDifference) <= RECONCILIATION_TOLERANCE;
}

export interface TallyEmployeeMatch {
  name: string | null;
}

export type TallyRowIdentityStatus = "matched" | "name_mismatch" | "unknown_employee";

export interface TallyRowResolution {
  row: TallyBalanceRow;
  status: TallyRowIdentityStatus;
  /** The PesoWise profile name, when a profile for this Employee ID exists. */
  pesoWiseName: string | null;
}

export interface TallyReconciliationSummary {
  /** Rows that WILL be staged: matched + name-mismatch (Employee ID is authoritative). */
  importableRows: TallyRowResolution[];
  /** Rows that will NOT be staged: the Employee ID does not exist in PesoWise. */
  unknownEmployeeRows: TallyRowResolution[];
  matchedCount: number;
  nameMismatchCount: number;
  unknownEmployeeCount: number;
  /** Rows skipped because Particulars had no extractable Employee ID at all. */
  identityFailureCount: number;
  /** Rows skipped because the Closing Balance amount itself was unreadable. */
  amountFailureCount: number;
  /** SUM of rows that will actually be staged/imported. */
  importableTotal: number;
  /** SUM of financially-known rows that will be skipped (unknown employee + unidentified). */
  skippedKnownTotal: number;
  sheetFinancialTotal: number;
  reportGrandTotal: number | null;
  /** Sheet-level reconciliation: sheetFinancialTotal vs reportGrandTotal. Never affected by identity. */
  sheetReconciles: boolean;
  /** Proof that importable + skipped-known accounts for the entire sheet financial total. */
  importSumMatchesSheetTotal: boolean;
}

/**
 * Resolves every parsed row against PesoWise's known employees for this
 * organization and produces the importable/skipped split the wizard's
 * Continue gate and staging step are built on. Employee ID is always
 * authoritative identity -- a name mismatch never changes which row is
 * matched, and no fuzzy/name-based matching is ever attempted for an
 * unknown Employee ID.
 */
export function computeTallyReconciliation(
  result: Extract<TallyParseResult, { ok: true }>,
  employeesById: Record<string, TallyEmployeeMatch>,
): TallyReconciliationSummary {
  const resolutions: TallyRowResolution[] = result.rows.map((row) => {
    const known = employeesById[row.employeeId];
    if (!known) return { row, status: "unknown_employee", pesoWiseName: null };
    const differs =
      known.name === null || known.name.trim().toLowerCase() !== row.employeeName.trim().toLowerCase();
    return { row, status: differs ? "name_mismatch" : "matched", pesoWiseName: known.name };
  });

  const importableRows = resolutions.filter((r) => r.status !== "unknown_employee");
  const unknownEmployeeRows = resolutions.filter((r) => r.status === "unknown_employee");

  const importableTotal = round2(importableRows.reduce((sum, r) => sum + r.row.signedClosingBalance, 0));
  const skippedKnownTotal = round2(
    unknownEmployeeRows.reduce((sum, r) => sum + r.row.signedClosingBalance, 0) +
      result.unidentifiedRows.reduce((sum, r) => sum + r.signedClosingBalance, 0),
  );

  return {
    importableRows,
    unknownEmployeeRows,
    matchedCount: resolutions.filter((r) => r.status === "matched").length,
    nameMismatchCount: resolutions.filter((r) => r.status === "name_mismatch").length,
    unknownEmployeeCount: unknownEmployeeRows.length,
    identityFailureCount: result.unidentifiedRows.length,
    amountFailureCount: result.amountFailures.length,
    importableTotal,
    skippedKnownTotal,
    sheetFinancialTotal: result.sheetFinancialTotal,
    reportGrandTotal: result.reportGrandTotal,
    sheetReconciles: reconciles(result),
    importSumMatchesSheetTotal:
      Math.abs(round2(importableTotal + skippedKnownTotal) - result.sheetFinancialTotal) <= RECONCILIATION_TOLERANCE,
  };
}

/** effective_date the anchor should use, given the admin's explicit Case A/B choice. */
export function resolveTallyEffectiveDate(
  periodEnd: string,
  usage: "opening_balance" | "balance_update",
): string {
  if (usage === "balance_update") return periodEnd;
  const [y, m, d] = periodEnd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}
