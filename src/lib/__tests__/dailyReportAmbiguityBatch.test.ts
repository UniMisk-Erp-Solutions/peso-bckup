/**
 * Page-scoped ambiguity batch: fetchProjectNameAmbiguityBatch (the browser
 * side of get_daily_report_project_name_ambiguity_batch_v2), and its merge
 * into runDailyProjectReportExport's rows.
 *
 * Covers the redesign in
 * 20260829120000_daily_report_remarks_and_batch_ambiguity.sql: ambiguity
 * moved OUT of report_daily_project_rows_v1 (a whole-population scan that
 * caused two real Production incidents) into this narrow, page-scoped RPC.
 * These tests exist to prove the browser's merge logic never asks for more
 * than the project ids on the page in hand, and that the worker
 * (supabase/functions/run-report-export-job/index.ts) reaches the same
 * ambiguity decision for the same inputs — a parity guarantee, not just a
 * browser-side unit test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import {
  fetchProjectNameAmbiguityBatch,
  runDailyProjectReportExport,
  parseDailyReportPage,
  DAILY_REPORT_SCHEMA_VERSION,
  type DailyReportPage,
} from "@/lib/dailyProjectReportPaging";
import {
  DAILY_REPORT_AMBIGUOUS_NAME_MARKER,
  DAILY_REPORT_NO_DATA_MARKER,
} from "@/lib/dailyExpenseReportConfig";

beforeEach(() => {
  rpcMock.mockReset();
});

describe("fetchProjectNameAmbiguityBatch", () => {
  it("calls the batch RPC with the organization id and de-duplicated, trimmed project ids", async () => {
    rpcMock.mockResolvedValue({
      data: [{ project_id: "P-1", project_name_ambiguous: true }],
      error: null,
    });

    const result = await fetchProjectNameAmbiguityBatch("org-1", ["P-1", " P-1 ", "P-1", "  "]);

    expect(rpcMock).toHaveBeenCalledWith("get_daily_report_project_name_ambiguity_batch_v2", {
      p_organization_id: "org-1",
      p_project_ids: ["P-1"],
    });
    expect(result.get("P-1")).toBe(true);
  });

  it("returns an empty map without calling the RPC when there are no project ids", async () => {
    const result = await fetchProjectNameAmbiguityBatch("org-1", ["", "   "]);
    expect(result.size).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("maps missing project ids to false via the caller's default, not the RPC", async () => {
    rpcMock.mockResolvedValue({
      data: [{ project_id: "P-1", project_name_ambiguous: true }],
      error: null,
    });
    const result = await fetchProjectNameAmbiguityBatch("org-1", ["P-1", "P-2"]);
    expect(result.get("P-1")).toBe(true);
    expect(result.has("P-2")).toBe(false); // caller treats "absent" as false
  });

  it("throws a DailyReportExportError when the RPC errors", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "denied" } });
    await expect(fetchProjectNameAmbiguityBatch("org-1", ["P-1"])).rejects.toMatchObject({
      code: "ambiguity_batch_failed",
    });
  });
});

describe("runDailyProjectReportExport — ambiguity merge", () => {
  const SNAPSHOT = "2026-08-29T00:00:00.000Z";

  function serverRow(over: Partial<Record<string, unknown>> = {}) {
    return {
      track_date: "2026-08-03",
      user_id: "11111111-1111-1111-1111-111111111111",
      project_id: "P-1",
      project_name: "",
      location: "",
      voucher_no: "",
      employee_name: "Ajay",
      employee_code: "6754",
      projects_in_employee_day: 1,
      costs: {},
      source_expenses: [],
      ...over,
    };
  }

  it("requests ambiguity only for the distinct project ids present on the page, and merges the result", async () => {
    const rows = [
      serverRow({ project_id: "P-1", user_id: "u1" }),
      serverRow({ project_id: "P-2", user_id: "u1" }),
      serverRow({ project_id: "P-1", user_id: "u2" }), // same project id, different row
    ];
    const fetchPage = vi.fn(
      async (): Promise<DailyReportPage> =>
        parseDailyReportPage({
          schema_version: DAILY_REPORT_SCHEMA_VERSION,
          snapshot_at: SNAPSHOT,
          page_size: 250,
          total_count: 3,
          returned: 3,
          has_more: false,
          next_cursor: null,
          rows,
        }),
    );

    const requestedIds: string[][] = [];
    const fetchAmbiguityBatch = vi.fn(async (_org: string, ids: string[]) => {
      requestedIds.push([...ids].sort());
      return new Map([["P-1", true]]); // P-2 absent -> false
    });

    const out = await runDailyProjectReportExport({
      organizationId: "org-1",
      delay: async () => {},
      fetchPage,
      fetchAmbiguityBatch,
    });

    // Exactly the two distinct ids on this page — never a third, never the
    // organization's full population.
    expect(requestedIds).toEqual([["P-1", "P-2"]]);

    // projectName was blank on every row, so ambiguity flows through into
    // the rendered "project name" marker: P-1 rows show the ambiguous
    // marker, P-2's does not (it shows the plain "no data" marker instead).
    const p1Rows = out.results.filter((r) => r.row["project id"] === "P-1");
    const p2Rows = out.results.filter((r) => r.row["project id"] === "P-2");
    expect(p1Rows).toHaveLength(2);
    expect(p2Rows).toHaveLength(1);
    for (const r of p1Rows) expect(r.row["project name"]).toBe(DAILY_REPORT_AMBIGUOUS_NAME_MARKER);
    for (const r of p2Rows) expect(r.row["project name"]).toBe(DAILY_REPORT_NO_DATA_MARKER);
  });

  it("aborts the whole export if the ambiguity batch fails, same as a page failure", async () => {
    const fetchPage = vi.fn(
      async (): Promise<DailyReportPage> =>
        parseDailyReportPage({
          schema_version: DAILY_REPORT_SCHEMA_VERSION,
          snapshot_at: SNAPSHOT,
          page_size: 250,
          total_count: 1,
          returned: 1,
          has_more: false,
          next_cursor: null,
          rows: [serverRow()],
        }),
    );
    const fetchAmbiguityBatch = vi.fn(async () => {
      throw new Error("index lookup failed");
    });

    await expect(
      runDailyProjectReportExport({
        organizationId: "org-1",
        delay: async () => {},
        fetchPage,
        fetchAmbiguityBatch,
      }),
    ).rejects.toMatchObject({ code: "ambiguity_batch_failed" });
  });

  it("treats a project id absent from the batch result as not ambiguous (fail-open on the marker, not on correctness)", async () => {
    const fetchPage = vi.fn(
      async (): Promise<DailyReportPage> =>
        parseDailyReportPage({
          schema_version: DAILY_REPORT_SCHEMA_VERSION,
          snapshot_at: SNAPSHOT,
          page_size: 250,
          total_count: 1,
          returned: 1,
          has_more: false,
          next_cursor: null,
          rows: [serverRow({ project_id: "P-9" })],
        }),
    );
    const fetchAmbiguityBatch = vi.fn(async () => new Map<string, boolean>());

    const out = await runDailyProjectReportExport({
      organizationId: "org-1",
      delay: async () => {},
      fetchPage,
      fetchAmbiguityBatch,
    });
    expect(out.results[0].row["project name"]).toBe(DAILY_REPORT_NO_DATA_MARKER);
  });
});
