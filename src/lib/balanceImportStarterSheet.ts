import * as XLSX from "xlsx";
import type { ImportMode } from "@/services/BalanceLedgerService";
import type { StagedImportRow } from "@/services/BalanceImportService";

// Owner-reported bugfix (2026-08-24): the wizard previously showed a
// column-mapping step whose auto-guess regex matched "Current Balance" and
// "Opening Balance" to the same "amount" field, and whose date cell reader
// only handled JS `Date` values -- an Excel numeric date serial (e.g. the
// spreadsheet's Effective Date column) fell through to `String(value)` and
// was sent to Postgres as the literal text "46204", which a `date` column
// correctly rejects.
//
// This module replaces both: there is no mapping step. The PesoWise starter
// sheet has one fixed, named column layout per mode, matched by header text
// (trimmed, case-insensitive), never by position and never guessed.

export type ParsedSheet = {
  headers: string[];
  rows: (string | number | Date | null)[][];
};

export interface StarterSheetSchema {
  employeeIdIndex: number;
  employeeNameIndex: number;
  emailIndex: number;
  currentBalanceIndex: number;
  amountIndex: number;
  effectiveDateIndex: number;
  noteIndex: number;
}

export type SchemaResolution =
  | { ok: true; schema: StarterSheetSchema }
  | { ok: false; missing: string[] };

/** The amount column's header text differs by mode; every other column is shared. */
export function amountHeaderForMode(mode: ImportMode): string {
  switch (mode) {
    case "historical_opening":
      return "Opening Balance";
    case "balance_update":
      return "Balance Update";
    case "allocation":
      return "Allocation Amount";
  }
}

export function canonicalStarterHeaders(mode: ImportMode): string[] {
  return [
    "Employee ID",
    "Employee Name",
    "Email",
    "Current Balance",
    amountHeaderForMode(mode),
    "Effective Date",
    "Note",
  ];
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Matches the uploaded sheet's headers against the exact canonical PesoWise
 * starter-sheet layout for this mode. Comparison is trim + case-insensitive
 * only -- never a fuzzy/regex guess of which column is financial. Columns
 * not in the canonical set are ignored (harmless extra columns, e.g. a
 * helper column the admin added, do not block the import).
 */
export function resolveStarterSheetSchema(headers: string[], mode: ImportMode): SchemaResolution {
  const canonical = canonicalStarterHeaders(mode);
  const indexByNormalized = new Map<string, number>();
  headers.forEach((header, idx) => {
    const key = normalizeHeader(header);
    if (!indexByNormalized.has(key)) indexByNormalized.set(key, idx);
  });

  const missing: string[] = [];
  const resolved: Partial<Record<string, number>> = {};
  for (const column of canonical) {
    const idx = indexByNormalized.get(normalizeHeader(column));
    if (idx === undefined) {
      missing.push(column);
    } else {
      resolved[column] = idx;
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    schema: {
      employeeIdIndex: resolved["Employee ID"]!,
      employeeNameIndex: resolved["Employee Name"]!,
      emailIndex: resolved["Email"]!,
      currentBalanceIndex: resolved["Current Balance"]!,
      amountIndex: resolved[amountHeaderForMode(mode)]!,
      effectiveDateIndex: resolved["Effective Date"]!,
      noteIndex: resolved["Note"]!,
    },
  };
}

export function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

export function cellToNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

type DateParseResult = { ok: true; iso: string | null } | { ok: false };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Constructing then reading back in UTC catches invalid days (e.g. Feb 30)
  // that a naive range check would miss, without any local-timezone shift.
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/**
 * Normalizes an Effective Date cell to "YYYY-MM-DD" for the `date`-typed
 * `balance_import_rows.effective_date` column. Handles the three shapes a
 * spreadsheet cell can actually arrive in:
 *   - a JS `Date` (SheetJS `cellDates: true`, or a CSV-producer edge case)
 *   - an Excel numeric date serial (SheetJS's default with `raw: true` --
 *     this is what produced the reported bug)
 *   - a plain "YYYY-MM-DD" string
 * Never returns a raw numeric-serial string; Postgres rejects that outright.
 * Blank returns null (no date supplied). Non-blank but unparseable returns
 * `{ ok: false }` so the caller can fail the row instead of staging garbage.
 */
export function excelCellToIsoDate(value: unknown): DateParseResult {
  if (value === null || value === undefined) return { ok: true, iso: null };

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false };
    // Read with UTC getters: SheetJS anchors a parsed calendar date at UTC
    // midnight, so `toISOString()`/local getters can shift the calendar day
    // by +-1 depending on the runtime's timezone offset.
    const y = value.getUTCFullYear();
    const m = value.getUTCMonth() + 1;
    const d = value.getUTCDate();
    if (!isValidCalendarDate(y, m, d)) return { ok: false };
    return { ok: true, iso: `${y}-${pad2(m)}-${pad2(d)}` };
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false };
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed || !isValidCalendarDate(parsed.y, parsed.m, parsed.d)) return { ok: false };
    return { ok: true, iso: `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}` };
  }

  const s = String(value).trim();
  if (s === "") return { ok: true, iso: null };

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (!isValidCalendarDate(y, m, d)) return { ok: false };
    return { ok: true, iso: s };
  }

  // Defensive: some producers (a CSV re-export of an Excel file, certain
  // `raw` modes) can hand back a bare numeric string instead of a number.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const parsed = XLSX.SSF.parse_date_code(n);
    if (parsed && isValidCalendarDate(parsed.y, parsed.m, parsed.d)) {
      return { ok: true, iso: `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}` };
    }
  }

  return { ok: false };
}

export interface BuiltStagedRows {
  rows: StagedImportRow[];
  /** 1-based row numbers whose Effective Date cell was non-blank but unparseable. */
  invalidDateRows: number[];
}

/**
 * Builds staged rows directly from the resolved starter-sheet schema -- no
 * column mapping involved. Current Balance is intentionally never read here:
 * it is reference-only and must never become `inputAmount`.
 */
export function buildStagedRowsFromSheet(
  parsedSheet: ParsedSheet,
  schema: StarterSheetSchema,
): BuiltStagedRows {
  const invalidDateRows: number[] = [];
  const rows: StagedImportRow[] = parsedSheet.rows.map((row, idx) => {
    const rowNumber = idx + 1;
    const dateResult = excelCellToIsoDate(row[schema.effectiveDateIndex]);
    if (!dateResult.ok) invalidDateRows.push(rowNumber);
    return {
      rowNumber,
      rawEmployeeId: cellToString(row[schema.employeeIdIndex]),
      rawEmail: cellToString(row[schema.emailIndex]),
      inputAmount: cellToNumber(row[schema.amountIndex]),
      effectiveDate: dateResult.ok ? dateResult.iso : null,
      note: cellToString(row[schema.noteIndex]),
    };
  });
  return { rows, invalidDateRows };
}
