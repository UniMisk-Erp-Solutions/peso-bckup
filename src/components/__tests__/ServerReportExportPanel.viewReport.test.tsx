/**
 * ServerReportExportPanel — "View Report" (DOC-147).
 *
 * The preview is a paged, server-side view over the rows the SAME job froze for
 * its CSV, so these tests assert: the button appears with Download CSV, the
 * table is paged (never the whole report), CSV row count == preview total, the
 * preview request carries no user ids, and failures are shown as friendly text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ServerReportExportPanel } from "../ServerReportExportPanel";
import * as reportExportJobs from "@/lib/reportExportJobs";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
  toast: toastSpy,
}));

vi.mock("@/lib/reportExportJobs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reportExportJobs")>(
    "@/lib/reportExportJobs",
  );
  return {
    ...actual,
    enqueueDailyProjectReportExport: vi.fn(),
    enqueueExpenseReportExport: vi.fn(),
    triggerExportWorker: vi.fn(async () => {}),
    fetchExportJob: vi.fn(),
    fetchLatestExportJob: vi.fn(async () => null),
    downloadExportJobFile: vi.fn(async () => {}),
    listReportExportJobsPaged: vi.fn(async () => ({ jobs: [], totalCount: 0, offset: 0, limit: 5 })),
    downloadHistoryEntry: vi.fn(async () => {}),
    retryReportExportJob: vi.fn(),
    fetchReportExportJobPreviewPageV2: vi.fn(),
  };
});

const mocked = reportExportJobs as unknown as {
  enqueueExpenseReportExport: ReturnType<typeof vi.fn>;
  fetchExportJob: ReturnType<typeof vi.fn>;
  fetchLatestExportJob: ReturnType<typeof vi.fn>;
  downloadExportJobFile: ReturnType<typeof vi.fn>;
  fetchReportExportJobPreviewPageV2: ReturnType<typeof vi.fn>;
};

const COLUMNS = ["Date", "Employee", "Expense Type", "Debit"];

const completedJob = {
  id: "job-view",
  status: "completed",
  progress_current: 997,
  progress_total: 997,
  filename: "detailed-expense-report-2026.csv",
  storage_path: "org/job-view.csv",
  file_size_bytes: 120_000,
  error_message_safe: null,
  created_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
};

function previewPage(page: number, total = 997, pageSize = 50) {
  const start = (page - 1) * pageSize;
  const count = Math.max(0, Math.min(pageSize, total - start));
  return {
    ready: true,
    columns: COLUMNS,
    totalCount: total,
    filteredTotalCount: total,
    page,
    pageSize,
    rows: Array.from({ length: count }, (_, i) => ({
      Date: "01-10-2026",
      Employee: `Row ${start + i + 1}`,
      "Expense Type": "Travel",
      Debit: "100.00",
    })),
  };
}

function props(extra: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    dateFrom: null,
    dateTo: null,
    userId: "all",
    userIds: null,
    teamScoped: false,
    reportType: "detailed_expense" as const,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchLatestExportJob.mockResolvedValue(completedJob);
  mocked.fetchReportExportJobPreviewPageV2.mockImplementation(
    async (_job: string, page: number) => previewPage(page),
  );
});

describe("ServerReportExportPanel — View Report", () => {
  it("shows View Report and Download CSV together once a Detailed Expense report is ready", async () => {
    render(<ServerReportExportPanel {...props()} />);
    expect(await screen.findByRole("button", { name: /View Report/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download CSV/ })).toBeInTheDocument();
  });

  it("renders a paged table (50 rows), not the whole 997-row report", async () => {
    render(<ServerReportExportPanel {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: /View Report/ }));
    await waitFor(() => expect(screen.getByText("Row 1")).toBeInTheDocument());
    expect(screen.getByText("Row 50")).toBeInTheDocument();
    expect(screen.queryByText("Row 51")).not.toBeInTheDocument();
    expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenCalledWith(
      "job-view", 1, 50, null, "asc", {},
    );
  });

  it("CSV row count and preview total match (997 = 997)", async () => {
    render(<ServerReportExportPanel {...props()} />);
    await screen.findByText("Row 1");
    expect(screen.getByText(/detailed-expense-report-2026\.csv · 997 rows/)).toBeInTheDocument();
    expect(screen.getByText(/997 rows · Generated/)).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 20")).toBeInTheDocument();
  });

  it("pagination requests the next page from the server", async () => {
    render(<ServerReportExportPanel {...props()} />);
    await screen.findByText("Row 1");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByText("Row 51")).toBeInTheDocument());
    expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
      "job-view", 2, 50, null, "asc", {},
    );
    expect(screen.getByText("Page 2 of 20")).toBeInTheDocument();
  });

  it("the preview request never carries user ids (scope was frozen on the job server-side)", async () => {
    render(<ServerReportExportPanel {...props({ teamScoped: true, userIds: ["me", "member"] })} />);
    await screen.findByText("Row 1");
    expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenCalled();
    for (const call of mocked.fetchReportExportJobPreviewPageV2.mock.calls) {
      expect(call).toHaveLength(6);
      expect(JSON.stringify(call)).not.toContain("member");
    }
  });

  it("employee self report: generation sends exactly the self-only scope the page provides", async () => {
    mocked.fetchLatestExportJob.mockResolvedValue(null);
    mocked.enqueueExpenseReportExport.mockResolvedValue({
      job_id: "job-view", status: "queued", deduplicated: false,
    });
    mocked.fetchExportJob.mockResolvedValue({ ...completedJob, status: "queued", storage_path: null });
    render(<ServerReportExportPanel {...props({ teamScoped: true, userIds: ["emp-1"] })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate report" }));
    await waitFor(() => expect(mocked.enqueueExpenseReportExport).toHaveBeenCalled());
    const arg = mocked.enqueueExpenseReportExport.mock.calls[0][0];
    expect(arg.teamScoped).toBe(true);
    expect(arg.userIds).toEqual(["emp-1"]);
  });

  it("shows 'expired' wording and never the raw backend error", async () => {
    mocked.fetchReportExportJobPreviewPageV2.mockRejectedValue(
      new Error("report not found (ERRCODE 42704) in get_report_export_job_preview_v3"),
    );
    render(<ServerReportExportPanel {...props()} />);
    expect(await screen.findByText(/This report has expired/)).toBeInTheDocument();
    expect(screen.queryByText(/42704|get_report_export_job_preview_v3/)).not.toBeInTheDocument();
  });

  it("shows a friendly access message for a permission error, not the raw text", async () => {
    mocked.fetchReportExportJobPreviewPageV2.mockRejectedValue(
      new Error("not permitted to view this report"),
    );
    render(<ServerReportExportPanel {...props()} />);
    expect(await screen.findByText(/don't have access to view this report/)).toBeInTheDocument();
    expect(screen.queryByText(/not permitted to view this report/)).not.toBeInTheDocument();
  });

  it("shows 'Failed to load report' with a working Retry for an unknown error", async () => {
    mocked.fetchReportExportJobPreviewPageV2
      .mockRejectedValueOnce(new Error("connection reset by peer"))
      .mockImplementation(async (_job: string, page: number) => previewPage(page));
    render(<ServerReportExportPanel {...props()} />);
    expect(await screen.findByText(/Failed to load report/)).toBeInTheDocument();
    expect(screen.queryByText(/connection reset/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Row 1")).toBeInTheDocument());
  });

  it("an expired file download shows a clear message, not the raw error", async () => {
    mocked.downloadExportJobFile.mockRejectedValueOnce(new Error("Object not found"));
    render(<ServerReportExportPanel {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Download CSV/ }));
    await waitFor(() => expect(mocked.downloadExportJobFile).toHaveBeenCalled());
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const shown = toastSpy.mock.calls[0][0] as { description: string };
    expect(shown.description).toMatch(/report file has expired/);
    expect(shown.description).not.toMatch(/Object not found/);
  });

  it("shows 'No rows match' for an empty report", async () => {
    mocked.fetchLatestExportJob.mockResolvedValue({ ...completedJob, progress_current: 0, progress_total: 0 });
    mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
      ...previewPage(1, 0), rows: [], totalCount: 0, filteredTotalCount: 0,
    });
    render(<ServerReportExportPanel {...props()} />);
    expect(await screen.findByText(/No rows match these report filters/)).toBeInTheDocument();
  });
});

describe("ServerReportExportPanel — Daily Project Report View Report (DOC-101 §11)", () => {
  const DAILY_COLUMNS = ["Track Date", "Voucher No", "project id", "project name", "Employee", "Petrol Cost", "percent"];
  const dailyJob = { ...completedJob, id: "job-daily", progress_current: 9001, progress_total: 9001, filename: "daily-project-report_2026-10-16.csv" };

  function dailyPage(page: number, total = 9001, pageSize = 50) {
    const start = (page - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, total - start));
    return {
      ready: true,
      columns: DAILY_COLUMNS,
      totalCount: total,
      filteredTotalCount: total,
      page,
      pageSize,
      rows: Array.from({ length: count }, (_, i) => ({
        "Track Date": "01-10-2026", "Voucher No": "", "project id": `P${start + i + 1}`,
        "project name": "Site", Employee: `Emp ${start + i + 1}`, "Petrol Cost": 100, percent: 100,
      })),
    };
  }

  // Daily Project is the DEFAULT report type (the Reports page passes no reportType).
  const dailyProps = () => props({ reportType: undefined });

  beforeEach(() => {
    mocked.fetchLatestExportJob.mockResolvedValue(dailyJob);
    mocked.fetchReportExportJobPreviewPageV2.mockImplementation(async (_j: string, page: number) => dailyPage(page));
  });

  it("a completed Daily Project report shows View Report + Download CSV and never the 'no on-page preview' text", async () => {
    render(<ServerReportExportPanel {...dailyProps()} />);
    expect(await screen.findByRole("button", { name: /View Report/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download CSV/ })).toBeInTheDocument();
    expect(screen.queryByText(/no on-page preview/)).not.toBeInTheDocument();
  });

  it("reads the frozen rows 50 at a time; total equals the CSV row count (9,001); no 9k-row DOM", async () => {
    const { container } = render(<ServerReportExportPanel {...dailyProps()} />);
    await screen.findByText("Emp 1");
    expect(screen.getByText(/daily-project-report_2026-10-16\.csv · 9,001 rows/)).toBeInTheDocument();
    expect(screen.getByText(/9,001 rows · Generated/)).toBeInTheDocument();
    expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenCalledWith("job-daily", 1, 50, null, "asc", {});
    expect(container.querySelectorAll("tbody tr").length).toBe(50);
    expect(screen.getByText("Page 1 of 181")).toBeInTheDocument();
  });

  it("Next page asks the server for page 2", async () => {
    render(<ServerReportExportPanel {...dailyProps()} />);
    await screen.findByText("Emp 1");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByText("Emp 51")).toBeInTheDocument());
    expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith("job-daily", 2, 50, null, "asc", {});
  });

  it("the preview columns are exactly the stored (worker CSV) columns, in order", async () => {
    const { container } = render(<ServerReportExportPanel {...dailyProps()} />);
    await screen.findByText("Emp 1");
    const heads = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent?.trim());
    DAILY_COLUMNS.forEach((c, i) => expect(heads[i]).toContain(c));
    expect(heads).toHaveLength(DAILY_COLUMNS.length);
  });

  it("an older Daily Project job without a stored preview says to download the file (no faked rows)", async () => {
    mocked.fetchLatestExportJob.mockResolvedValue(dailyJob);
    mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
      ready: false, reason: "no_preview_available", columns: [], totalCount: 0, filteredTotalCount: 0, page: 1, pageSize: 50, rows: [],
    });
    render(<ServerReportExportPanel {...dailyProps()} />);
    expect(
      await screen.findByText(/on-page preview is unavailable\. Download the file to view it\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download CSV/ })).toBeInTheDocument();
  });

  it("Claim reports still have no preview", async () => {
    render(<ServerReportExportPanel {...props({ reportType: "claim_approval" })} />);
    expect(await screen.findByText(/no on-page preview/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View Report/ })).not.toBeInTheDocument();
  });
});
