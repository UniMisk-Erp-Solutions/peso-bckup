/**
 * Executes the worker's actual Remarks transformation logic, not just
 * source-content assertions.
 *
 * `supabase/functions/run-report-export-job/index.ts` cannot be imported in
 * Vitest: it exports nothing, and its top-level `Deno.serve(...)` call would
 * throw `Deno is not defined` under Node the instant the module loads. This
 * file mirrors the EXACT `toGroup`/`finalize` Remarks logic byte-for-byte
 * (verified against the real file by `reportExportWorker.test.ts`'s source
 * assertions, kept in sync here) and executes it directly, plus cross-checks
 * its output against the real, imported foreground implementation
 * (`finalizeDailyReportGroups`) on identical input.
 *
 * This specific cross-check is the single most important test in this
 * integration. The bug this whole module exists to fix was exactly this: the
 * first Remarks fix touched only the foreground row builder, verified it
 * repeatedly, and shipped with the actual downloaded CSV still blank --
 * because the download is built by this worker, which re-implements the row
 * shaping independently and was calling a different RPC that didn't carry
 * `purpose` at all. A drift between these two functions is exactly the class
 * of bug that made three rounds of "verified" false.
 */
import { describe, expect, it } from "vitest";
import {
  finalizeDailyReportGroups,
  type DailyReportGroup,
} from "@/lib/buildDailyProjectExpenseReport";

/**
 * Mirror of worker/index.ts's `toGroup`'s remarks extraction (lines around
 * `const srcRows = ...` / `const remarks = srcRows...`). Byte-for-byte
 * identical logic: same optional-chaining, same trim, same blank filter, no
 * sort, no dedupe.
 */
function workerExtractRemarks(sourceExpenses: Array<Record<string, unknown>>): string[] {
  const srcRows = Array.isArray(sourceExpenses) ? sourceExpenses : [];
  return srcRows
    .map((src) => String(src?.purpose ?? "").trim())
    .filter((p) => p !== "");
}

/** Mirror of worker/index.ts's `finalize`'s Remarks cell assignment. */
function workerJoinRemarks(remarks: string[]): string {
  return remarks.join(", ");
}

describe("worker Remarks logic (executed mirror)", () => {
  it("one source expense produces its own purpose", () => {
    const remarks = workerExtractRemarks([{ purpose: "Auto" }]);
    expect(workerJoinRemarks(remarks)).toBe("Auto");
  });

  it("multiple source expenses comma-join in the RPC's own order", () => {
    const remarks = workerExtractRemarks([{ purpose: "Auto" }, { purpose: "Private vehicle" }]);
    expect(workerJoinRemarks(remarks)).toBe("Auto, Private vehicle");
  });

  it("keeps duplicates -- ['Auto','Private vehicle','','Auto'] -> 'Auto, Private vehicle, Auto', not deduplicated", () => {
    const remarks = workerExtractRemarks([
      { purpose: "Auto" },
      { purpose: "Private vehicle" },
      { purpose: "" },
      { purpose: "Auto" },
    ]);
    expect(workerJoinRemarks(remarks)).toBe("Auto, Private vehicle, Auto");
  });

  it("skips blank/whitespace/null/undefined purposes without a stray comma", () => {
    const remarks = workerExtractRemarks([
      { purpose: "Auto" },
      { purpose: "   " },
      { purpose: null },
      { purpose: undefined },
      {},
      { purpose: "Private vehicle" },
    ]);
    expect(workerJoinRemarks(remarks)).toBe("Auto, Private vehicle");
  });

  it("all blank produces an empty string", () => {
    const remarks = workerExtractRemarks([{ purpose: "" }, { purpose: null }]);
    expect(workerJoinRemarks(remarks)).toBe("");
  });

  it("a non-array source_expenses (malformed RPC response) degrades to empty, never throws", () => {
    // deno-lint mirrors this defensively too: Array.isArray guard.
    expect(() => workerExtractRemarks(null as unknown as Array<Record<string, unknown>>)).not.toThrow();
    expect(workerJoinRemarks(workerExtractRemarks(null as unknown as Array<Record<string, unknown>>))).toBe("");
  });
});

describe("output parity: worker (mirrored) vs foreground finalizeDailyReportGroups", () => {
  function group(overrides: Partial<DailyReportGroup> = {}): DailyReportGroup {
    return {
      trackDate: "10-05-2026",
      userId: "user-1",
      projectId: "P1",
      projectName: "Alpha",
      location: "Site A",
      voucherNo: "V1",
      employeeName: "Ravi",
      employeeCode: "EMP01",
      costs: {
        petrol_cost: 0, material_cost: 0, travelling_cost: 0, phone_exp: 0,
        hotel_exp: 0, transport_exp: 0, contra_bill: 0, other_exp: 0,
      },
      sourceExpenses: [],
      ...overrides,
    };
  }

  const CASES: Array<{ name: string; purposes: (string | null)[] }> = [
    { name: "single remark", purposes: ["Auto"] },
    { name: "multiple distinct remarks", purposes: ["Auto", "Private vehicle"] },
    { name: "duplicates preserved", purposes: ["Auto", "Private vehicle", "", "Auto"] },
    { name: "all blank", purposes: ["", null, "   "] },
    { name: "mixed real data", purposes: ["Doormatory", "Private lucjury", "Auto", "Personal auto"] },
  ];

  it.each(CASES)("$name: foreground and worker-mirror produce the identical Remarks string", ({ purposes }) => {
    const sourceExpenses = purposes.map((purpose, i) => ({
      id: `e${i}`,
      category: "Fuel",
      total_amount: 10,
      trip_start: "2026-05-10",
      title: null,
      transaction_number: null,
      voucherNo: "",
      costColumn: "other_exp" as const,
      costColumnLabel: "Other Exp.",
      projectId: "P1",
      projectName: "Alpha",
      location: "Site A",
      purpose,
    }));

    // Foreground: real, imported implementation.
    const [foregroundResult] = finalizeDailyReportGroups([group({ sourceExpenses })]);

    // Worker: mirrored implementation, fed the same purposes in the same order
    // (both pipelines read purpose off the same per-expense records; the
    // worker reads it from source_expenses[].purpose, the foreground reads it
    // from sourceExpenses[].purpose -- same field, same values here).
    const workerRemarks = workerJoinRemarks(
      workerExtractRemarks(purposes.map((purpose) => ({ purpose }))),
    );

    expect(foregroundResult.row["Remarks"]).toBe(workerRemarks);
  });

  it("the exact reference case from the source incident: 'Doormatory, Private lucjury, Auto, Personal auto'", () => {
    const purposes = ["Doormatory", "Private lucjury", "Auto", "Personal auto"];
    const sourceExpenses = purposes.map((purpose, i) => ({
      id: `e${i}`, category: "Fuel", total_amount: 10, trip_start: "2026-07-03",
      title: null, transaction_number: null, voucherNo: "", costColumn: "other_exp" as const,
      costColumnLabel: "Other Exp.", projectId: "P1", projectName: "Alpha", location: "Site A",
      purpose,
    }));
    const [result] = finalizeDailyReportGroups([group({ sourceExpenses })]);
    expect(result.row["Remarks"]).toBe("Doormatory, Private lucjury, Auto, Personal auto");
  });
});

describe("CSV escaping of Remarks values (RFC 4180)", () => {
  // Mirrors expenseReports.ts / index.ts's csvCell exactly: quote if the
  // value contains a comma, quote, or newline; double up embedded quotes.
  function csvCell(v: string | number): string {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  it("a Remarks value that itself contains a comma (from the join) is quoted as one field", () => {
    // The join already produces "Taxi, Auto" -- csvCell must wrap the WHOLE
    // joined string in quotes so it reads back as one cell, not two columns.
    const remarks = "Taxi, Auto";
    expect(csvCell(remarks)).toBe('"Taxi, Auto"');
  });

  it("embedded double quotes in a purpose are doubled, not escaped with a backslash", () => {
    const remarks = 'Driver said "paid"';
    expect(csvCell(remarks)).toBe('"Driver said ""paid"""');
  });

  it("embedded newlines force quoting so the row does not split", () => {
    const remarks = "Line one\nLine two";
    expect(csvCell(remarks)).toBe('"Line one\nLine two"');
  });

  it("a plain remark with no special characters is not quoted at all", () => {
    expect(csvCell("Auto")).toBe("Auto");
  });

  it("Unicode (Hindi/Gujarati) purposes pass through untouched and unquoted unless they also contain a comma/quote/newline", () => {
    expect(csvCell("ऑटो")).toBe("ऑटो");
    expect(csvCell("ખાનગી વાહન")).toBe("ખાનગી વાહન");
    expect(csvCell("ऑटो, ખાનગી વાહન")).toBe('"ऑटो, ખાનગી વાહન"');
  });

  it("a comma-joined multi-remark Unicode value round-trips as a single valid CSV field", () => {
    const joined = ["ऑटो", "ખાનગી વાહન"].join(", ");
    const cell = csvCell(joined);
    expect(cell).toBe('"ऑटो, ખાનગી વાહન"');
    // Un-escaping: strip the wrapping quotes and un-double the inner quotes --
    // must reproduce the original joined string exactly.
    const unescaped = cell.slice(1, -1).replace(/""/g, '"');
    expect(unescaped).toBe(joined);
  });
});
