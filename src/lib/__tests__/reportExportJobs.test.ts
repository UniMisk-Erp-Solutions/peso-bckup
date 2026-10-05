/**
 * src/lib/reportExportJobs.ts -- the client-side enqueue/poll/download
 * surface for server-side report generation.
 *
 * `isTerminalStatus`/`formatBytes` are pure and exercised directly. The
 * enqueue/fetch/download functions are thin wrappers around
 * `supabase.rpc()`/`.from()`/`.storage` calls whose real behavior is
 * already covered by the SQL contract tests (serverSideReportGeneration.test.ts)
 * and the shared mock in src/test/setup.ts does not model a full
 * report_export_jobs query-builder chain, so the RPC-name/filter-shape
 * contract is verified as a source guard instead of re-mocking Supabase --
 * matching the density-hotfix precedent elsewhere in this codebase for
 * pages/services whose real data pipeline needs more mocking than a
 * surgical change warrants.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  isTerminalStatus,
  formatBytes,
  formatHistoryParameterSummary,
  type ExportHistoryEntry,
} from "@/lib/reportExportJobs";

const cwd = process.cwd();
const src = readFileSync(resolve(cwd, "src/lib/reportExportJobs.ts"), "utf-8");

describe("isTerminalStatus", () => {
  it("completed, failed and cancelled are terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });

  it("queued and running are not terminal", () => {
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("returns empty string for null/zero/negative", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(-5)).toBe("");
  });

  it("formats bytes, kilobytes and megabytes at their natural boundaries", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("listReportExportJobsPaged (DOC-131, upgraded to v3 in the owner QA fix pass)", () => {
  it("calls list_report_export_jobs_v4 (all lifecycle states) -- v1-v3 are untouched and still callable by anything else", () => {
    const start = src.indexOf("export async function listReportExportJobsPaged(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain('"list_report_export_jobs_v4"');
    expect(body).toContain("p_offset: offset");
    expect(body).toContain("p_limit: limit");
  });

  it("defaults to a 5-per-page history, matching the required page size", () => {
    const start = src.indexOf("export async function listReportExportJobsPaged(");
    const body = src.slice(start, src.indexOf(")", start));
    expect(body).toContain("limit = 5");
  });

  it("surfaces total_count so the caller never has to guess pages from rows.length", () => {
    const start = src.indexOf("export async function listReportExportJobsPaged(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("totalCount: payload?.total_count");
  });
});

describe("fetchReportExportJobPreviewPage (DOC-131)", () => {
  it("calls get_report_export_job_preview_v1 with the job id, page and page size", () => {
    const start = src.indexOf("export async function fetchReportExportJobPreviewPage(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain('"get_report_export_job_preview_v1"');
    expect(body).toContain("p_job_id: jobId");
    expect(body).toContain("p_page: page");
    expect(body).toContain("p_page_size: pageSize");
  });

  it("defaults to a 50-row page, matching the preferred preview page size", () => {
    const start = src.indexOf("export async function fetchReportExportJobPreviewPage(");
    const body = src.slice(start, src.indexOf(")", start));
    expect(body).toContain("pageSize = 50");
  });

  it("degrades to ready:false rather than throwing when the envelope is missing fields", () => {
    const start = src.indexOf("export async function fetchReportExportJobPreviewPage(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("payload?.ready ?? false");
  });
});

describe("enqueue contract", () => {
  it("Daily Project Report enqueues via create_daily_project_report_export_job_v1", () => {
    const start = src.indexOf("export async function enqueueDailyProjectReportExport(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain('db.rpc("create_daily_project_report_export_job_v1"');
    expect(body).toContain("p_format: input.format ?? \"csv\"");
  });

  it("Daily Project Report omits the 'all' Employee-filter sentinel instead of sending it as p_user_id (a uuid column) -- regression test for 'invalid input syntax for type uuid: \"all\"'", () => {
    const start = src.indexOf("export async function enqueueDailyProjectReportExport(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain('input.userId && input.userId !== "all" ? input.userId : null');
  });

  it("expense reports enqueue via create_expense_report_export_job_v1, one function shared by all three types", () => {
    const start = src.indexOf("export async function enqueueExpenseReportExport(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain('db.rpc("create_expense_report_export_job_v1"');
    expect(body).toContain("p_format: \"csv\"");
  });

  it("expense-report filters omit unset/'all' values instead of sending them as literal strings the SQL side would need to special-case", () => {
    const start = src.indexOf("export async function enqueueExpenseReportExport(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain('input.category && input.category !== "all"');
    expect(body).toContain('input.userId && input.userId !== "all"');
    expect(body).toContain('input.engineerStatus && input.engineerStatus !== "all"');
  });

  it("the worker nudge is fire-and-forget -- a failed invoke must not fail the enqueue", () => {
    const start = src.indexOf("export async function triggerExportWorker(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("try {");
    expect(body).toContain("catch {");
  });

  it("download asks the server to sign by job_id -- never signs Storage directly with the caller's own JWT, and never sends bucket/path/filename as client-supplied authority", () => {
    const start = src.indexOf("export async function downloadExportJobFile(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain('"get-report-export-download-url"');
    expect(body).toContain("{ job_id: job.id }");
    expect(body).not.toContain(".storage.from(");
    expect(body).not.toContain("createSignedUrl");
  });

  it("a historical entry downloads through the same job_id-based path, carrying its own id", () => {
    const start = src.indexOf("export async function downloadHistoryEntry(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("id: entry.id");
  });

  it("history is scoped per report type via list_report_export_jobs_v1 and unwraps the {jobs} envelope", () => {
    const start = src.indexOf("export async function listReportExportJobs(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain('db.rpc("list_report_export_jobs_v1"');
    expect(body).toContain("payload?.jobs ?? []");
  });

  it("Detailed Expense sends custom_field_filters and the raw Year/Month/Week selection into parameters, not just the resolved dates", () => {
    const start = src.indexOf("export async function enqueueExpenseReportExport(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("filters.custom_field_filters = input.customFieldFilters");
    expect(body).toContain("filters.year = input.selectedYear");
    expect(body).toContain('input.selectedMonth !== "all"');
    expect(body).toContain('input.selectedWeek !== "all"');
  });
});

describe("formatHistoryParameterSummary (owner QA fix pass -- Report History parameter display)", () => {
  function entry(overrides: Partial<ExportHistoryEntry> = {}): ExportHistoryEntry {
    return {
      id: "job1",
      status: "completed",
      filename: "report.csv",
      storage_path: "org/job1/report.csv",
      file_size_bytes: 1000,
      row_count: 10,
      created_at: "2026-06-15T00:00:00Z",
      completed_at: "2026-06-15T00:01:00Z",
      expires_at: null,
      requested_by_name: "Someone",
      requested_by_me: true,
      downloadable: true,
      ...overrides,
    };
  }

  it("returns null when the job has no stored parameters at all (a v1/v2 caller)", () => {
    expect(formatHistoryParameterSummary(entry({ parameters: undefined }))).toBeNull();
  });

  it("shows the server-resolved employee_display, never a raw user_id", () => {
    const summary = formatHistoryParameterSummary(
      entry({ parameters: { user_id: "11111111-1111-1111-1111-111111111111" }, employee_display: "Sagar Patel (5540)" }),
    );
    expect(summary?.employeeLine).toBe("Sagar Patel (5540)");
    expect(summary?.employeeLine).not.toContain("1111-1111");
  });

  it("shows \"All employees\" when the job's own parameters carry no user_id", () => {
    const summary = formatHistoryParameterSummary(entry({ parameters: {}, employee_display: null }));
    expect(summary?.employeeLine).toBe("All employees");
  });

  it("formats the frozen date_from/date_to as a DD Mon YYYY range, never today's date", () => {
    const summary = formatHistoryParameterSummary(
      entry({ parameters: { date_from: "2026-06-01", date_to: "2026-06-30" } }),
    );
    expect(summary?.rangeLine).toBe("01 Jun 2026 – 30 Jun 2026");
  });

  it("shows \"All time\" when the job's parameters carry no date range", () => {
    expect(formatHistoryParameterSummary(entry({ parameters: {} }))?.rangeLine).toBe("All time");
  });

  it("shows Expense Type: All when no category was recorded, and the actual category when one was", () => {
    expect(formatHistoryParameterSummary(entry({ parameters: {} }))?.chips).toContain("Expense Type: All");
    expect(
      formatHistoryParameterSummary(entry({ parameters: { category: "Fuel" } }))?.chips,
    ).toContain("Expense Type: Fuel");
  });

  it("omits the Week chip entirely for an older job that never recorded one, rather than fabricating \"Week: All\"", () => {
    const summary = formatHistoryParameterSummary(entry({ parameters: { category: "Fuel" } }));
    expect(summary?.chips.some((c) => c.startsWith("Week"))).toBe(false);
  });

  it("shows the Week chip when the job's own parameters recorded one", () => {
    const summary = formatHistoryParameterSummary(entry({ parameters: { week: "23" } }));
    expect(summary?.chips).toContain("Week: 23");
  });

  it("shows only the actively-filtered custom fields, skipping \"all\"-valued entries", () => {
    const summary = formatHistoryParameterSummary(
      entry({
        parameters: {
          custom_field_filters: { "Project ID": "P101", "Project Name": "all" },
        },
      }),
    );
    expect(summary?.chips).toContain("Project ID: P101");
    expect(summary?.chips.some((c) => c.startsWith("Project Name"))).toBe(false);
  });

  it("never re-derives the summary from anything other than this job's own frozen parameters", () => {
    // Two jobs with different parameters must produce different summaries,
    // proving the function reads per-entry state, not shared/ambient state.
    const a = formatHistoryParameterSummary(entry({ parameters: { category: "Fuel" } }));
    const b = formatHistoryParameterSummary(entry({ parameters: { category: "Travel" } }));
    expect(a?.chips).toContain("Expense Type: Fuel");
    expect(b?.chips).toContain("Expense Type: Travel");
  });
});
