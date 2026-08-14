/**
 * Central CSV serialization helpers.
 *
 * Every exported cell — headers and data alike — passes through `escapeCsvCell`.
 * Guarantees:
 *  - Commas, double-quotes, CR and LF inside any value are safely RFC-4180 escaped.
 *  - Formula-injection characters (=, +, -, @, TAB, CR) in user-controlled text are
 *    neutralized by prepending a single-quote so spreadsheet apps treat them as text.
 *    Numeric-looking strings (amounts, balances) are exempt from injection protection.
 *  - null / undefined become empty cells, never the string "null" or "undefined".
 *  - Numbers keep their numeric representation without extra quoting.
 *  - CRLF line endings (\r\n) ensure strong Excel / Google Sheets / LibreOffice compat.
 *  - Headers pass through the same serializer as data rows — no raw header strings.
 */

import { format } from "date-fns";
import { parseLocalDate } from "@/lib/format";

/** Spreadsheet formula trigger characters. */
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

/** Purely numeric string (integer or decimal, optionally negative) — exempt from formula protection. */
const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

/**
 * Serialize one CSV cell value.
 *
 * - `null` / `undefined`         → `""`  (empty cell)
 * - finite `number`              → its string representation, unquoted
 * - `boolean`                    → `"true"` / `"false"`
 * - `string`                     → formula-injection protected when needed,
 *                                  CSV-quoted when it contains `,  "  \n  \r`
 * - Numeric-looking strings (e.g. `"439.00"`, `"-100.50"`) are never formula-protected.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return String(value);

  const str = String(value);

  // Formula injection protection for user-controlled text.
  let safe = str;
  if (safe.length > 0 && FORMULA_PREFIX_RE.test(safe) && !NUMERIC_STRING_RE.test(safe)) {
    safe = "'" + safe;
  }

  // RFC-4180: wrap in double-quotes and escape internal double-quotes.
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\r")) {
    return '"' + safe.replace(/"/g, '""') + '"';
  }
  return safe;
}

/**
 * Serialize one row as a CSV line (no trailing newline).
 * Every value passes through `escapeCsvCell`.
 */
export function serializeCsvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvCell).join(",");
}

/**
 * Serialize a complete CSV document with CRLF line endings.
 * Both headers and data rows pass through `escapeCsvCell`.
 *
 * @param headers - Column header strings
 * @param rows    - Data rows; each must have the same length as `headers`
 */
export function serializeCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const allRows: readonly (readonly unknown[])[] = [headers, ...rows];
  return allRows.map(serializeCsvRow).join("\r\n");
}

/**
 * Format a date-only string (YYYY-MM-DD) for CSV export as `dd-MMM-yyyy`.
 * Uses local-date parsing to avoid timezone off-by-one errors.
 * Returns `""` for invalid or missing input.
 *
 * Example: `"2026-07-22"` → `"22-Jul-2026"`
 */
export function formatCsvDate(dateStr: string | null | undefined): string {
  const d = parseLocalDate(dateStr);
  if (!d) return "";
  try {
    return format(d, "dd-MMM-yyyy");
  } catch {
    return "";
  }
}

/**
 * Format an ISO timestamp for CSV export as `dd-MMM-yyyy hh:mm a` (local browser time).
 * Comma-free by design — safe to use in CSV cells without additional quoting.
 * Returns `""` for invalid or missing input.
 *
 * Example: `"2026-07-22T05:34:00.000Z"` (UTC, IST browser) → `"22-Jul-2026 11:04 AM"`
 */
export function formatCsvTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return format(d, "dd-MMM-yyyy hh:mm a");
  } catch {
    return "";
  }
}
