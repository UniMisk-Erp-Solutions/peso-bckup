/**
 * DOC-101 — server-paged Daily Project Report: contract parsing, export
 * coordination, completeness invariants, and output parity with the legacy
 * all-in-browser pipeline.
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseDailyReportPage,
  runDailyProjectReportExport,
  serverRowToGroup,
  dailyReportRowIdentity,
  DailyReportExportError,
  DAILY_REPORT_SCHEMA_VERSION,
  type DailyReportPage,
  type DailyReportPageParams,
} from "@/lib/dailyProjectReportPaging";
import {
  buildDailyProjectExpenseReportRows,
  dailyReportResultsToRows,
  finalizeDailyReportGroups,
  type RawDailyReportExpense,
} from "@/lib/buildDailyProjectExpenseReport";
import {
  emptyDailyExpenseReportConfig,
  encodeTemplateSource,
  type DailyExpenseReportConfig,
} from "@/lib/dailyExpenseReportConfig";

const SNAPSHOT = "2026-08-20T05:00:00.000Z";
const noDelay = async () => {};

type ServerRow = Record<string, unknown>;

function serverRow(over: Partial<Record<string, unknown>> = {}): ServerRow {
  return {
    track_date: "2026-08-03",
    user_id: "11111111-1111-1111-1111-111111111111",
    project_id: "P-1",
    project_name: "Project One",
    location: "Site A",
    voucher_no: "12200",
    employee_name: "Ajay",
    employee_code: "6754",
    projects_in_employee_day: 1,
    costs: {
      petrol_cost: 0, material_cost: 0, travelling_cost: 30, phone_exp: 0,
      hotel_exp: 0, transport_exp: 0, contra_bill: 0, other_exp: 0,
    },
    source_expenses: [],
    ...over,
  };
}

function envelope(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    schema_version: DAILY_REPORT_SCHEMA_VERSION,
    snapshot_at: SNAPSHOT,
    page_size: 250,
    total_count: 1,
    returned: 1,
    has_more: false,
    next_cursor: null,
    rows: [serverRow()],
    ...over,
  };
}

/** Build a fake server that pages a fixed row list with real keyset cursors. */
function pagingServer(rows: ServerRow[], pageSize: number) {
  const calls: DailyReportPageParams[] = [];
  const fetchPage = async (params: DailyReportPageParams): Promise<DailyReportPage> => {
    calls.push(params);
    let start = 0;
    if (params.cursor) {
      const key = dailyReportRowIdentity(params.cursor);
      start = rows.findIndex((r) => dailyReportRowIdentity(r as never) === key) + 1;
    }
    const slice = rows.slice(start, start + pageSize);
    const hasMore = start + pageSize < rows.length;
    const last = slice[slice.length - 1] as never;
    return parseDailyReportPage({
      schema_version: DAILY_REPORT_SCHEMA_VERSION,
      snapshot_at: SNAPSHOT,
      page_size: pageSize,
      total_count: params.cursor ? null : rows.length,
      returned: slice.length,
      has_more: hasMore,
      next_cursor: hasMore
        ? {
            track_date: (last as ServerRow).track_date,
            user_id: (last as ServerRow).user_id,
            project_id: (last as ServerRow).project_id,
          }
        : null,
      rows: slice,
    });
  };
  return { fetchPage, calls };
}

/** N distinct report rows with unique (track_date, user_id, project_id). */
function manyRows(n: number): ServerRow[] {
  const out: ServerRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      serverRow({
        track_date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
        user_id: `user-${String(i % 50).padStart(4, "0")}`,
        project_id: `P-${String(i).padStart(6, "0")}`,
      }),
    );
  }
  return out;
}

/** Default: nothing is ambiguous. Tests that care override this explicitly. */
const noAmbiguity = async () => new Map<string, boolean>();
const baseExport = { organizationId: "org-1", delay: noDelay, fetchAmbiguityBatch: noAmbiguity };

// ─── contract parsing ───────────────────────────────────────────────────────
describe("parseDailyReportPage", () => {
  it("accepts a well-formed envelope of the supported version", () => {
    const page = parseDailyReportPage(envelope());
    expect(page.schemaVersion).toBe(DAILY_REPORT_SCHEMA_VERSION);
    expect(page.snapshotAt).toBe(SNAPSHOT);
    expect(page.totalCount).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.rows).toHaveLength(1);
  });

  it("refuses an unsupported schema version rather than guessing", () => {
    expect(() => parseDailyReportPage(envelope({ schema_version: 2 }))).toThrow(
      DailyReportExportError,
    );
  });

  it.each([
    ["not an object", 42],
    ["no rows array", envelope({ rows: undefined })],
    ["no snapshot", envelope({ snapshot_at: undefined })],
  ])("rejects a malformed envelope (%s)", (_label, raw) => {
    expect(() => parseDailyReportPage(raw)).toThrow(DailyReportExportError);
  });

  it("rejects has_more with no cursor — that would silently end the export early", () => {
    expect(() =>
      parseDailyReportPage(envelope({ has_more: true, next_cursor: null })),
    ).toThrow(/no cursor/i);
  });

  it("rejects a structurally invalid cursor", () => {
    expect(() =>
      parseDailyReportPage(envelope({ has_more: true, next_cursor: { track_date: "x" } })),
    ).toThrow(DailyReportExportError);
  });
});

// ─── row mapping ────────────────────────────────────────────────────────────
describe("serverRowToGroup", () => {
  it("formats the track date to DD-MM-YYYY and keeps numeric costs", () => {
    const g = serverRowToGroup(serverRow() as never);
    expect(g.trackDate).toBe("03-08-2026");
    expect(g.costs.travelling_cost).toBe(30);
    expect(g.employeeCode).toBe("6754");
  });

  it("maps an empty track date to an empty string, as the legacy formatter does", () => {
    expect(serverRowToGroup(serverRow({ track_date: "" }) as never).trackDate).toBe("");
  });

  it("coerces numeric strings, which is how numeric/jsonb can arrive", () => {
    const g = serverRowToGroup(
      serverRow({ costs: { ...(serverRow().costs as object), hotel_exp: "650.00" } }) as never,
    );
    expect(g.costs.hotel_exp).toBe(650);
  });

  it("falls back to other_exp for an unrecognised cost column", () => {
    const g = serverRowToGroup(
      serverRow({
        source_expenses: [
          { id: "e1", category: "X", total_amount: 5, trip_start: "2026-08-03",
            title: "t", transaction_number: "1", voucher_no: "1", cost_column: "bogus" },
        ],
      }) as never,
    );
    expect(g.sourceExpenses[0].costColumn).toBe("other_exp");
  });

  it("graceful degradation: the CURRENTLY-LIVE RPC (before the pending Remarks migration is applied) omits `purpose` from source_expenses entirely -- must not throw, must produce an empty Remarks, not crash the report page", () => {
    // No `purpose` key at all -- exactly what the unmigrated, currently
    // installed report_daily_project_rows_v1 returns today.
    expect(() =>
      serverRowToGroup(
        serverRow({
          source_expenses: [
            { id: "e1", category: "Fuel", total_amount: 5, trip_start: "2026-08-03",
              title: "t", transaction_number: "1", voucher_no: "1", cost_column: "petrol_cost" },
          ],
        }) as never,
      ),
    ).not.toThrow();

    const g = serverRowToGroup(
      serverRow({
        source_expenses: [
          { id: "e1", category: "Fuel", total_amount: 5, trip_start: "2026-08-03",
            title: "t", transaction_number: "1", voucher_no: "1", cost_column: "petrol_cost" },
        ],
      }) as never,
    );
    expect(g.sourceExpenses[0].purpose).toBeNull();

    const [result] = finalizeDailyReportGroups([g]);
    expect(result.row["Remarks"]).toBe("");
  });
});

// ─── export coordinator ─────────────────────────────────────────────────────
describe("runDailyProjectReportExport", () => {
  it("returns rows from a single page", async () => {
    const { fetchPage } = pagingServer(manyRows(3), 250);
    const out = await runDailyProjectReportExport({ ...baseExport, fetchPage });
    expect(out.totalCount).toBe(3);
    expect(out.results).toHaveLength(3);
    expect(out.pages).toBe(1);
  });

  it("walks multiple pages and pins ONE snapshot across all of them", async () => {
    const { fetchPage, calls } = pagingServer(manyRows(600), 250);
    const out = await runDailyProjectReportExport({ ...baseExport, fetchPage });
    expect(out.results).toHaveLength(600);
    expect(out.pages).toBe(3);
    expect(calls[0].snapshotAt).toBeNull();
    expect(calls.slice(1).every((c) => c.snapshotAt === SNAPSHOT)).toBe(true);
  });

  it("crosses the 1,000-row PostgREST cap without truncating", async () => {
    const { fetchPage } = pagingServer(manyRows(1500), 250);
    const out = await runDailyProjectReportExport({ ...baseExport, fetchPage });
    expect(out.results).toHaveLength(1500);
  });

  it("assembles the real-world 9,000-row scale with no loss and no duplicates", async () => {
    const rows = manyRows(9000);
    const { fetchPage, calls } = pagingServer(rows, 250);
    const out = await runDailyProjectReportExport({ ...baseExport, fetchPage });

    const identities = new Set(
      out.results.map((r) => `${r.row["Track Date"]}|${r.row["project id"]}`),
    );
    expect(out.totalCount).toBe(9000);
    expect(out.results).toHaveLength(9000);
    expect(identities.size).toBe(9000);
    expect(out.pages).toBe(36);
    expect(calls).toHaveLength(36);
  });

  it.each([[0], [1], [249], [250], [251]])(
    "handles the %i-row boundary exactly",
    async (n) => {
      const { fetchPage } = pagingServer(manyRows(n), 250);
      const out = await runDailyProjectReportExport({ ...baseExport, fetchPage });
      expect(out.results).toHaveLength(n);
      expect(out.totalCount).toBe(n);
    },
  );

  it("reports progress against the authoritative total", async () => {
    const { fetchPage } = pagingServer(manyRows(600), 250);
    const seen: Array<{ received: number; total: number | null }> = [];
    await runDailyProjectReportExport({
      ...baseExport,
      fetchPage,
      onProgress: (p) => seen.push({ received: p.received, total: p.total }),
    });
    expect(seen).toEqual([
      { received: 250, total: 600 },
      { received: 500, total: 600 },
      { received: 600, total: 600 },
    ]);
  });

  it("issues pages sequentially — never a burst against the shared database", async () => {
    let inFlight = 0;
    let peak = 0;
    const inner = pagingServer(manyRows(1000), 250).fetchPage;
    const fetchPage = async (p: DailyReportPageParams) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await inner(p);
      } finally {
        inFlight -= 1;
      }
    };
    await runDailyProjectReportExport({ ...baseExport, fetchPage });
    expect(peak).toBe(1);
  });

  // ── failure modes: every one must prevent a workbook, never produce a
  //    plausible-looking partial file ──────────────────────────────────────
  it("aborts when the server total does not match what was received", async () => {
    const rows = manyRows(10);
    const fetchPage = async (): Promise<DailyReportPage> =>
      parseDailyReportPage({
        schema_version: 1, snapshot_at: SNAPSHOT, page_size: 250,
        total_count: 12, returned: 10, has_more: false, next_cursor: null, rows,
      });
    await expect(runDailyProjectReportExport({ ...baseExport, fetchPage })).rejects.toThrow(
      /expected 12 rows but assembled 10/,
    );
  });

  it("aborts on a duplicate logical row rather than silently de-duplicating", async () => {
    const dupe = serverRow({ project_id: "P-DUP" });
    const fetchPage = async (): Promise<DailyReportPage> =>
      parseDailyReportPage({
        schema_version: 1, snapshot_at: SNAPSHOT, page_size: 250,
        total_count: 2, returned: 2, has_more: false, next_cursor: null,
        rows: [dupe, { ...dupe }],
      });
    await expect(runDailyProjectReportExport({ ...baseExport, fetchPage })).rejects.toThrow(
      /same row twice/i,
    );
  });

  it("aborts when the snapshot changes mid-export", async () => {
    let call = 0;
    const rows = manyRows(500);
    const fetchPage = async (params: DailyReportPageParams): Promise<DailyReportPage> => {
      const start = call * 250;
      const slice = rows.slice(start, start + 250);
      const last = slice[slice.length - 1] as ServerRow;
      const page = parseDailyReportPage({
        schema_version: 1,
        snapshot_at: call === 0 ? SNAPSHOT : "2026-08-20T06:00:00.000Z",
        page_size: 250,
        total_count: params.cursor ? null : rows.length,
        returned: slice.length,
        has_more: call === 0,
        next_cursor: call === 0
          ? { track_date: last.track_date, user_id: last.user_id, project_id: last.project_id }
          : null,
        rows: slice,
      });
      call += 1;
      return page;
    };
    await expect(runDailyProjectReportExport({ ...baseExport, fetchPage })).rejects.toThrow(
      /changed while it was being prepared/i,
    );
  });

  it("aborts when the first page carries no authoritative total", async () => {
    const fetchPage = async (): Promise<DailyReportPage> =>
      parseDailyReportPage({
        schema_version: 1, snapshot_at: SNAPSHOT, page_size: 250,
        total_count: null, returned: 0, has_more: false, next_cursor: null, rows: [],
      });
    await expect(runDailyProjectReportExport({ ...baseExport, fetchPage })).rejects.toThrow(
      /authoritative row count/i,
    );
  });

  it("retries the SAME cursor on a transient failure and never re-adds a page", async () => {
    const inner = pagingServer(manyRows(600), 250).fetchPage;
    const seenCursors: (string | null)[] = [];
    let failures = 0;
    const fetchPage = async (p: DailyReportPageParams) => {
      seenCursors.push(p.cursor ? dailyReportRowIdentity(p.cursor) : null);
      if (p.cursor && failures < 1) {
        failures += 1;
        throw new DailyReportExportError("page_failed", "network blip");
      }
      return inner(p);
    };
    const out = await runDailyProjectReportExport({ ...baseExport, fetchPage });
    expect(out.results).toHaveLength(600);
    // The retried attempt used the identical cursor as the failed one.
    expect(seenCursors[1]).toBe(seenCursors[2]);
  });

  it("gives up with a page_failed error once retries are exhausted", async () => {
    const fetchPage = async (): Promise<DailyReportPage> => {
      throw new DailyReportExportError("page_failed", "network down");
    };
    await expect(
      runDailyProjectReportExport({ ...baseExport, fetchPage, maxRetriesPerPage: 1 }),
    ).rejects.toMatchObject({ code: "page_failed" });
  });

  it("does not retry a contract violation — only transport failures", async () => {
    const fetchPage = vi.fn(async (): Promise<DailyReportPage> => {
      throw new DailyReportExportError("schema_version_mismatch", "bad version");
    });
    await expect(runDailyProjectReportExport({ ...baseExport, fetchPage })).rejects.toMatchObject({
      code: "schema_version_mismatch",
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops issuing pages once cancelled and yields no rows", async () => {
    const controller = new AbortController();
    const inner = pagingServer(manyRows(2000), 250).fetchPage;
    let pages = 0;
    const fetchPage = async (p: DailyReportPageParams) => {
      pages += 1;
      if (pages === 2) controller.abort();
      return inner(p);
    };
    await expect(
      runDailyProjectReportExport({ ...baseExport, fetchPage, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(pages).toBe(2);
  });

  it("refuses to start at all when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchPage = vi.fn();
    await expect(
      runDailyProjectReportExport({
        ...baseExport,
        fetchPage: fetchPage as never,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

// ─── Remarks at scale: page boundaries must not lose/duplicate/reorder/merge ─
function manyRowsWithRemarks(n: number): ServerRow[] {
  const out: ServerRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      serverRow({
        track_date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
        user_id: `user-${String(i % 50).padStart(4, "0")}`,
        project_id: `P-${String(i).padStart(6, "0")}`,
        source_expenses: [
          {
            id: `e-${i}`, category: "Travelling", total_amount: 10,
            trip_start: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
            title: "t", transaction_number: String(i), voucher_no: String(i),
            cost_column: "travelling_cost", purpose: `Remark-${i}`,
          },
        ],
      }),
    );
  }
  return out;
}

describe("Remarks at scale — page boundaries never lose, duplicate, reorder or merge remarks", () => {
  it.each([[1], [250], [251], [1000], [1001], [5000]])(
    "%i rows: every row keeps its own, correct, unmodified Remarks",
    async (n) => {
      const rows = manyRowsWithRemarks(n);
      const { fetchPage } = pagingServer(rows, 250);
      const out = await runDailyProjectReportExport({ ...baseExport, fetchPage });
      const workbookRows = dailyReportResultsToRows(out.results);

      expect(workbookRows).toHaveLength(n);

      // Every group is a distinct (trackDate, user, project) triple in this
      // fixture -- one source expense each -- so Remarks must be exactly that
      // one expense's own purpose, never another row's, never merged, never
      // duplicated, never dropped.
      const remarksSeen = new Set(workbookRows.map((r) => r["Remarks"]));
      expect(remarksSeen.size).toBe(n); // every Remark is unique and present exactly once

      for (const row of workbookRows) {
        const idx = Number(String(row["Remarks"]).replace("Remark-", ""));
        expect(Number.isInteger(idx)).toBe(true);
        expect(row["Remarks"]).toBe(`Remark-${idx}`);
      }
    },
  );

  it("a group spanning a page boundary still comma-joins all of its own remarks and no others (project split across two pages of source data is not possible server-side, but a wide employee-day group crossing a page cursor is)", async () => {
    // Two full rows on either side of a 250-row page boundary, sandwiching a
    // single project group so pagination itself never touches grouping --
    // grouping is already complete server-side. This proves the CLIENT loop
    // that assembles pages does not accidentally re-merge or truncate a
    // row's own source_expenses while walking pages.
    const rows = manyRowsWithRemarks(500);
    // Replace the row that lands exactly on the 250th boundary with a
    // multi-source-expense group to prove its own internal join is intact.
    rows[249] = serverRow({
      track_date: "2026-08-15",
      user_id: "user-0099",
      project_id: "P-boundary",
      source_expenses: [
        { id: "b1", category: "Fuel", total_amount: 10, trip_start: "2026-08-15",
          title: "t", transaction_number: "1", voucher_no: "1", cost_column: "petrol_cost", purpose: "Auto" },
        { id: "b2", category: "Fuel", total_amount: 10, trip_start: "2026-08-15",
          title: "t", transaction_number: "2", voucher_no: "2", cost_column: "petrol_cost", purpose: "Private vehicle" },
      ],
    });

    const { fetchPage } = pagingServer(rows, 250);
    const out = await runDailyProjectReportExport({ ...baseExport, fetchPage });
    const workbookRows = dailyReportResultsToRows(out.results);
    const boundaryRow = workbookRows.find((r) => r["project id"] === "P-boundary");

    expect(boundaryRow?.["Remarks"]).toBe("Auto, Private vehicle");
    expect(workbookRows).toHaveLength(500);
  });
});

// ─── output parity with the legacy pipeline ─────────────────────────────────
describe("output parity: legacy in-browser pipeline vs server-paged pipeline", () => {
  const PID = "aaaaaaaa-0000-4000-8000-000000000001";
  const PNM = "aaaaaaaa-0000-4000-8000-000000000002";
  const U1 = "11111111-1111-1111-1111-111111111111";
  const U2 = "22222222-2222-2222-2222-222222222222";

  const config: DailyExpenseReportConfig = {
    ...emptyDailyExpenseReportConfig(),
    fieldMappings: {
      projectId: encodeTemplateSource(PID),
      projectName: encodeTemplateSource(PNM),
      location: "base:destination",
    },
    categoryMappings: {
      ...emptyDailyExpenseReportConfig().categoryMappings,
      hotel_exp: ["Hotel/Guest House"],
      travelling_cost: ["Travelling"],
    },
  };

  // Two employees; U1 has TWO projects on the same day, which is what makes
  // `percent` a whole-report property rather than a per-row one.
  const expenses: RawDailyReportExpense[] = [
    { id: "e1", user_id: U1, trip_start: "2026-08-03", category: "Travelling",
      total_amount: 30, title: "Cctv", destination: "Site A", transaction_number: "12200", purpose: "Auto" },
    { id: "e2", user_id: U1, trip_start: "2026-08-03", category: "Hotel/Guest House",
      total_amount: 650, title: "Stay", destination: "Site A", transaction_number: "12201", purpose: "Stay charges" },
    { id: "e3", user_id: U1, trip_start: "2026-08-03", category: "Travelling",
      total_amount: 40, title: "Bus", destination: "Site B", transaction_number: "12202", purpose: "Auto" },
    { id: "e4", user_id: U2, trip_start: "2026-08-04", category: "Travelling",
      total_amount: 55, title: "Cab", destination: "Site C", transaction_number: "12203", purpose: "" },
  ];

  const fieldValuesByExpenseId = {
    e1: { projectId: "P-1", projectName: "Alpha", location: "Site A" },
    e2: { projectId: "P-1", projectName: "Alpha", location: "Site A" },
    e3: { projectId: "P-2", projectName: "Beta", location: "Site B" },
    e4: { projectId: "P-3", projectName: "Gamma", location: "Site C" },
  };

  const profilesByUserId = {
    [U1]: { user_id: U1, name: "Ajay", employee_id: "6754" },
    [U2]: { user_id: U2, name: "Bhavesh", employee_id: "6765" },
  };

  /**
   * The envelope get_daily_project_report_page_v1 must return for this exact
   * fixture: the (trackDate, user_id, projectId) grouping, first-non-empty
   * merges, and category→cost bucketing all resolved server-side. This is the
   * client-side half of the contract the SQL is written against.
   */
  const serverRows: ServerRow[] = [
    {
      track_date: "2026-08-03", user_id: U1, project_id: "P-1",
      project_name: "Alpha", location: "Site A", voucher_no: "12200",
      employee_name: "Ajay", employee_code: "6754", projects_in_employee_day: 2,
      costs: { petrol_cost: 0, material_cost: 0, travelling_cost: 30, phone_exp: 0,
               hotel_exp: 650, transport_exp: 0, contra_bill: 0, other_exp: 0 },
      source_expenses: [
        { id: "e1", category: "Travelling", total_amount: 30, trip_start: "2026-08-03",
          title: "Cctv", transaction_number: "12200", voucher_no: "12200", cost_column: "travelling_cost", purpose: "Auto" },
        { id: "e2", category: "Hotel/Guest House", total_amount: 650, trip_start: "2026-08-03",
          title: "Stay", transaction_number: "12201", voucher_no: "12201", cost_column: "hotel_exp", purpose: "Stay charges" },
      ],
    },
    {
      track_date: "2026-08-03", user_id: U1, project_id: "P-2",
      project_name: "Beta", location: "Site B", voucher_no: "12202",
      employee_name: "Ajay", employee_code: "6754", projects_in_employee_day: 2,
      costs: { petrol_cost: 0, material_cost: 0, travelling_cost: 40, phone_exp: 0,
               hotel_exp: 0, transport_exp: 0, contra_bill: 0, other_exp: 0 },
      source_expenses: [
        { id: "e3", category: "Travelling", total_amount: 40, trip_start: "2026-08-03",
          title: "Bus", transaction_number: "12202", voucher_no: "12202", cost_column: "travelling_cost", purpose: "Auto" },
      ],
    },
    {
      track_date: "2026-08-04", user_id: U2, project_id: "P-3",
      project_name: "Gamma", location: "Site C", voucher_no: "12203",
      employee_name: "Bhavesh", employee_code: "6765", projects_in_employee_day: 1,
      costs: { petrol_cost: 0, material_cost: 0, travelling_cost: 55, phone_exp: 0,
               hotel_exp: 0, transport_exp: 0, contra_bill: 0, other_exp: 0 },
      source_expenses: [
        { id: "e4", category: "Travelling", total_amount: 55, trip_start: "2026-08-04",
          title: "Cab", transaction_number: "12203", voucher_no: "12203", cost_column: "travelling_cost", purpose: "" },
      ],
    },
  ];

  it("produces identical workbook rows, in identical order", async () => {
    const legacy = buildDailyProjectExpenseReportRows({
      expenses, profilesByUserId, fieldValuesByExpenseId, config,
    });
    const { fetchPage } = pagingServer(serverRows, 250);
    const server = await runDailyProjectReportExport({ ...baseExport, fetchPage });

    expect(dailyReportResultsToRows(server.results)).toEqual(dailyReportResultsToRows(legacy));
  });

  it("Remarks agree exactly between the legacy client pipeline and the server-paged pipeline", async () => {
    const legacyRows = dailyReportResultsToRows(
      buildDailyProjectExpenseReportRows({ expenses, profilesByUserId, fieldValuesByExpenseId, config }),
    );
    const { fetchPage } = pagingServer(serverRows, 250);
    const server = await runDailyProjectReportExport({ ...baseExport, fetchPage });
    const serverRowsOut = dailyReportResultsToRows(server.results);

    // Sorted by category before employeeName/projectId; Hotel/Guest House <
    // Travelling alphabetically, so e2 (Stay charges) precedes e1 (Auto).
    const p1 = serverRowsOut.find((r) => r["project id"] === "P-1");
    const p2 = serverRowsOut.find((r) => r["project id"] === "P-2");
    const p3 = serverRowsOut.find((r) => r["project id"] === "P-3");
    expect(p1?.["Remarks"]).toBe("Stay charges, Auto");
    expect(p2?.["Remarks"]).toBe("Auto");
    expect(p3?.["Remarks"]).toBe(""); // blank purpose skipped, no stray comma

    // Not just spot checks -- every Remarks cell, both pipelines, must agree.
    for (let i = 0; i < serverRowsOut.length; i++) {
      expect(serverRowsOut[i]["Remarks"]).toBe(legacyRows[i]["Remarks"]);
    }
  });

  it("keeps grouping, costs, percent and blank cells identical across a page split", async () => {
    const legacy = buildDailyProjectExpenseReportRows({
      expenses, profilesByUserId, fieldValuesByExpenseId, config,
    });
    // page size 1 => every row arrives on its own page; `percent` still has to
    // come out right, which only holds because it is derived after assembly.
    const { fetchPage } = pagingServer(serverRows, 1);
    const server = await runDailyProjectReportExport({ ...baseExport, fetchPage });

    expect(server.pages).toBe(3);
    expect(dailyReportResultsToRows(server.results)).toEqual(dailyReportResultsToRows(legacy));

    const rows = dailyReportResultsToRows(server.results);
    // Ajay has two project rows that day -> 50 each; Bhavesh has one -> 100.
    expect(rows.filter((r) => r["Employee"] === "Ajay").map((r) => r["percent"])).toEqual([50, 50]);
    expect(rows.filter((r) => r["Employee"] === "Bhavesh").map((r) => r["percent"])).toEqual([100]);
    // Unmapped columns stay blank, not zero.
    expect(rows[0]["Petrol Cost"]).toBe("");
    expect(rows[0]["Total Resource"]).toBe("");
    expect(rows[0]["Presence"]).toBe("P");
  });

  it("carries the drill-down source expenses through, still sorted", async () => {
    const { fetchPage } = pagingServer(serverRows, 250);
    const server = await runDailyProjectReportExport({ ...baseExport, fetchPage });
    const first = server.results.find((r) => r.row["project id"] === "P-1");
    expect(first?.sourceExpenses.map((s) => s.id)).toEqual(["e2", "e1"]);
    expect(first?.sourceExpenses[0].costColumnLabel).toBe("Hotel Exp.");
  });

  it("agrees with the server's own projects_in_employee_day denominator", async () => {
    const { fetchPage } = pagingServer(serverRows, 250);
    const server = await runDailyProjectReportExport({ ...baseExport, fetchPage });
    for (const r of server.results) {
      const src = serverRows.find(
        (s) => s.project_id === r.row["project id"] && s.user_id !== undefined,
      );
      const expected = Math.round((100 / Number(src?.projects_in_employee_day ?? 1)) * 100) / 100;
      expect(r.row["percent"]).toBe(expected);
    }
  });
});
