/**
 * ServerReportExportPanel -- Generate / progress / completed / failed /
 * download / history states, mocking src/lib/reportExportJobs.ts entirely
 * (its own contract is covered separately by reportExportJobs.test.ts and
 * the SQL/worker contract tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ServerReportExportPanel } from "../ServerReportExportPanel";
import * as reportExportJobs from "@/lib/reportExportJobs";

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
    listReportExportJobs: vi.fn(async () => []),
    listReportExportJobsPaged: vi.fn(async () => ({ jobs: [], totalCount: 0, offset: 0, limit: 5 })),
    downloadHistoryEntry: vi.fn(async () => {}),
    retryReportExportJob: vi.fn(),
    fetchReportExportJobPreviewPageV2: vi.fn(async () => ({
      ready: false, reason: "no_preview_available", columns: [], totalCount: 0, filteredTotalCount: 0,
      page: 1, pageSize: 50, rows: [],
    })),
  };
});

const mocked = reportExportJobs as unknown as {
  enqueueDailyProjectReportExport: ReturnType<typeof vi.fn>;
  enqueueExpenseReportExport: ReturnType<typeof vi.fn>;
  fetchExportJob: ReturnType<typeof vi.fn>;
  fetchLatestExportJob: ReturnType<typeof vi.fn>;
  downloadExportJobFile: ReturnType<typeof vi.fn>;
  listReportExportJobs: ReturnType<typeof vi.fn>;
  listReportExportJobsPaged: ReturnType<typeof vi.fn>;
  downloadHistoryEntry: ReturnType<typeof vi.fn>;
  triggerExportWorker: ReturnType<typeof vi.fn>;
  retryReportExportJob: ReturnType<typeof vi.fn>;
  fetchReportExportJobPreviewPageV2: ReturnType<typeof vi.fn>;
};

function baseProps() {
  return {
    organizationId: "org-1",
    dateFrom: null,
    dateTo: null,
    userId: "all",
    userIds: null,
    teamScoped: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchLatestExportJob.mockResolvedValue(null);
  mocked.listReportExportJobs.mockResolvedValue([]);
  mocked.listReportExportJobsPaged.mockResolvedValue({ jobs: [], totalCount: 0, offset: 0, limit: 5 });
  mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
    ready: false, reason: "no_preview_available", columns: [], totalCount: 0, filteredTotalCount: 0,
    page: 1, pageSize: 50, rows: [],
  });
});

describe("ServerReportExportPanel", () => {
  it("shows Generate report and no Download button before anything runs", async () => {
    render(<ServerReportExportPanel {...baseProps()} />);
    expect(await screen.findByRole("button", { name: "Generate report" })).toBeInTheDocument();
    expect(screen.queryByText("Download CSV")).not.toBeInTheDocument();
  });

  it("enqueues the Daily Project Report job (no reportType prop) and shows the generating state", async () => {
    mocked.enqueueDailyProjectReportExport.mockResolvedValue({
      job_id: "job-1",
      status: "queued",
      deduplicated: false,
    });
    mocked.fetchExportJob.mockResolvedValue({
      id: "job-1",
      status: "running",
      progress_current: 0,
      progress_total: null,
      filename: null,
      storage_path: null,
      file_size_bytes: null,
      error_message_safe: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });

    render(<ServerReportExportPanel {...baseProps()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate report" }));

    await waitFor(() => {
      expect(mocked.enqueueDailyProjectReportExport).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: "org-1", format: "csv" }),
      );
    });
    expect(await screen.findByText("Generating on server…")).toBeInTheDocument();
  });

  it("enqueues an expense report job with reportType, category and engineerStatus when provided", async () => {
    mocked.enqueueExpenseReportExport.mockResolvedValue({
      job_id: "job-2",
      status: "queued",
      deduplicated: false,
    });
    mocked.fetchExportJob.mockResolvedValue({
      id: "job-2",
      status: "queued",
      progress_current: 0,
      progress_total: null,
      filename: null,
      storage_path: null,
      file_size_bytes: null,
      error_message_safe: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });

    render(
      <ServerReportExportPanel
        {...baseProps()}
        reportType="claim_verification"
        category="travel"
        engineerStatus="verified"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Generate report" }));

    await waitFor(() => {
      expect(mocked.enqueueExpenseReportExport).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          reportType: "claim_verification",
          category: "travel",
          engineerStatus: "verified",
        }),
      );
    });
  });

  it("shows a Download CSV button once the job completes, and downloads via the signed-URL helper on click", async () => {
    mocked.fetchLatestExportJob.mockResolvedValue({
      id: "job-3",
      status: "completed",
      progress_current: 100,
      progress_total: 100,
      filename: "claim-verification-list_2026-08-27.csv",
      storage_path: "org-1/job-3/claim-verification-list_2026-08-27.csv",
      file_size_bytes: 2048,
      error_message_safe: null,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    render(<ServerReportExportPanel {...baseProps()} reportType="claim_verification" />);

    const downloadButton = await screen.findByText("Download CSV");
    expect(screen.getByText(/claim-verification-list_2026-08-27\.csv/)).toBeInTheDocument();

    fireEvent.click(downloadButton);
    await waitFor(() => expect(mocked.downloadExportJobFile).toHaveBeenCalled());
  });

  it("shows the error message and a Try again button when the job fails", async () => {
    // The initial fetchExportJob result only sets `job`; the error banner is
    // populated by the first poll tick's terminal-status branch (POLL_MS =
    // 2000ms) -- real behavior of the component, not a test artifact.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      mocked.enqueueDailyProjectReportExport.mockResolvedValue({
        job_id: "job-4",
        status: "queued",
        deduplicated: false,
      });
      mocked.fetchExportJob.mockResolvedValue({
        id: "job-4",
        status: "failed",
        progress_current: 0,
        progress_total: null,
        filename: null,
        storage_path: null,
        file_size_bytes: null,
        error_message_safe: "The report could not be generated.",
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });

      render(<ServerReportExportPanel {...baseProps()} />);
      const generateButton = await screen.findByRole("button", { name: "Generate report" });
      await fireEvent.click(generateButton);
      await vi.waitFor(() => expect(mocked.enqueueDailyProjectReportExport).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(2000);

      expect(screen.getByText("The report could not be generated.")).toBeInTheDocument();
      expect(screen.getByText("Try again")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("history lists a downloadable entry with a working Download button", async () => {
    mocked.listReportExportJobsPaged.mockResolvedValue({
      jobs: [
        {
          id: "h1",
          status: "completed",
          filename: "claim-approval-list_2026-08-20.csv",
          storage_path: "org-1/h1/claim-approval-list_2026-08-20.csv",
          file_size_bytes: 4096,
          row_count: 250,
          created_at: "2026-08-20T10:00:00.000Z",
          completed_at: "2026-08-20T10:01:00.000Z",
          expires_at: "2026-08-27T10:00:00.000Z",
          requested_by_name: "Alex",
          requested_by_me: false,
          downloadable: true,
        },
      ],
      totalCount: 1,
      offset: 0,
      limit: 5,
    });

    render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);

    expect(await screen.findByText("claim-approval-list_2026-08-20.csv")).toBeInTheDocument();
    expect(screen.getByText(/Alex/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Download"));
    await waitFor(() => expect(mocked.downloadHistoryEntry).toHaveBeenCalled());
  });

  it("history shows 'File expired' with no button for a non-downloadable entry -- never a button that would 404", async () => {
    mocked.listReportExportJobsPaged.mockResolvedValue({
      jobs: [
        {
          id: "h2",
          status: "completed",
          filename: "detailed-expense-report_2026-08-01.csv",
          storage_path: null,
          file_size_bytes: 4096,
          row_count: 100,
          created_at: "2026-08-01T10:00:00.000Z",
          completed_at: "2026-08-01T10:01:00.000Z",
          expires_at: "2026-08-08T10:00:00.000Z",
          requested_by_name: "Sam",
          requested_by_me: true,
          downloadable: false,
        },
      ],
      totalCount: 1,
      offset: 0,
      limit: 5,
    });

    render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);

    expect(await screen.findByText("File expired")).toBeInTheDocument();
    expect(screen.queryByText("Download")).not.toBeInTheDocument();
  });

  it("restores a completed job on mount so a reload does not force regeneration", async () => {
    mocked.fetchLatestExportJob.mockResolvedValue({
      id: "job-5",
      status: "completed",
      progress_current: 50,
      progress_total: 50,
      filename: "daily-project-report_2026-08-27.csv",
      storage_path: "org-1/job-5/daily-project-report_2026-08-27.csv",
      file_size_bytes: 1024,
      error_message_safe: null,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    render(<ServerReportExportPanel {...baseProps()} />);

    expect(await screen.findByText("Download CSV")).toBeInTheDocument();
    expect(mocked.enqueueDailyProjectReportExport).not.toHaveBeenCalled();
  });

  it("disables the Generate button when disabled prop is set or organizationId is missing", async () => {
    const { rerender } = render(<ServerReportExportPanel {...baseProps()} disabled />);
    expect(await screen.findByRole("button", { name: "Generate report" })).toBeDisabled();

    rerender(<ServerReportExportPanel {...baseProps()} organizationId={null} />);
    expect(await screen.findByRole("button", { name: "Generate report" })).toBeDisabled();
  });

  describe("Detailed Expense on-page preview (DOC-131)", () => {
    function completedDetailedJob() {
      return {
        id: "job-preview-1",
        status: "completed" as const,
        progress_current: 120,
        progress_total: 120,
        filename: "detailed-expense_2026-09-23.csv",
        storage_path: "org-1/job-preview-1/detailed-expense_2026-09-23.csv",
        file_size_bytes: 8192,
        error_message_safe: null,
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      };
    }

    it("loads Preview Page 1 automatically once a completed report is found on mount — no extra click needed", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(completedDetailedJob());
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
        ready: true,
        reason: null,
        columns: ["Employee", "Employee ID", "Date", "Credit", "Debit"],
        totalCount: 120,
        filteredTotalCount: 120,
        page: 1,
        pageSize: 50,
        rows: [{ Employee: "Aa One", "Employee ID": "E-1", Date: "01-09-2026", Credit: "", Debit: "₹100.00" }],
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);

      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenCalledWith(
          "job-preview-1", 1, 50, null, "asc", {},
        ),
      );
      expect(await screen.findByText("Aa One")).toBeInTheDocument();
      expect(screen.getByText("Employee ID")).toBeInTheDocument();
      // "Showing" is derived from page/pageSize/filteredTotalCount, not the
      // actual returned row count (a partial mock fixture here still has 120
      // total, and no filter is active so it matches totalCount too).
      expect(screen.getByText(/Showing 1–50 of 120/)).toBeInTheDocument();
    });

    it("Next loads the following page with the correct page number, and Previous returns", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(completedDetailedJob());
      mocked.fetchReportExportJobPreviewPageV2.mockImplementation(async (_jobId, page) => ({
        ready: true,
        reason: null,
        columns: ["Employee ID"],
        totalCount: 120,
        filteredTotalCount: 120,
        page,
        pageSize: 50,
        rows: [{ "Employee ID": `row-for-page-${page}` }],
      }));

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);

      await screen.findByText("row-for-page-1");
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenCalledWith(
          "job-preview-1", 2, 50, null, "asc", {},
        ),
      );
      expect(await screen.findByText("row-for-page-2")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenCalledWith(
          "job-preview-1", 1, 50, null, "asc", {},
        ),
      );
      expect(await screen.findByText("row-for-page-1")).toBeInTheDocument();
    });

    it("shows 'No rows match these report filters.' when the preview is ready but empty, not a spinner or an error", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(completedDetailedJob());
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
        ready: true, reason: null, columns: ["Employee"], totalCount: 0, filteredTotalCount: 0,
        page: 1, pageSize: 50, rows: [],
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);

      expect(await screen.findByText("No rows match these report filters.")).toBeInTheDocument();
    });

    it("hides the preview section entirely for report types with no stored preview (Claim Verification, etc.)", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue({
        ...completedDetailedJob(),
        filename: "claim-verification-list_2026-09-23.csv",
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="claim_verification" />);

      await screen.findByText("Download CSV");
      expect(mocked.fetchReportExportJobPreviewPageV2).not.toHaveBeenCalled();
      expect(screen.queryByText("Generated report")).not.toBeInTheDocument();
    });

    it("does not treat a not-yet-completed job's preview as an error — no preview section renders for it", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(null);

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);

      await screen.findByRole("button", { name: "Generate report" });
      expect(mocked.fetchReportExportJobPreviewPageV2).not.toHaveBeenCalled();
      expect(screen.queryByText("Generated report")).not.toBeInTheDocument();
    });
  });

  describe("Excel-style preview sort/filter (owner final preview UX pass)", () => {
    function completedDetailedJob() {
      return {
        id: "job-preview-1",
        status: "completed" as const,
        progress_current: 5,
        progress_total: 5,
        filename: "detailed-expense_2026-09-23.csv",
        storage_path: "org-1/job-preview-1/detailed-expense_2026-09-23.csv",
        file_size_bytes: 8192,
        error_message_safe: null,
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      };
    }

    function baseRows() {
      return {
        ready: true as const,
        reason: null,
        columns: ["Employee", "Date", "Debit"],
        totalCount: 5,
        filteredTotalCount: 5,
        page: 1,
        pageSize: 50,
        rows: [{ Employee: "Anil Thakor", Date: "01-06-2026", Debit: "₹9,000.00" }],
      };
    }

    it("clicking Sort Asc on a column calls the RPC with that sort column and resets to page 1", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(completedDetailedJob());
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue(baseRows());

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("Anil Thakor");

      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Debit" }));
      fireEvent.click(await screen.findByRole("button", { name: "Asc" }));

      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
          "job-preview-1", 1, 50, "Debit", "asc", {},
        ),
      );
    });

    it("applying a text 'contains' filter calls the RPC with that column filter and shows the matching/total messaging", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(completedDetailedJob());
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce(baseRows());
      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("Anil Thakor");

      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce({
        ...baseRows(),
        filteredTotalCount: 2,
      });

      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Employee" }));
      const containsInput = await screen.findByPlaceholderText("Contains…");
      fireEvent.change(containsInput, { target: { value: "Anil" } });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
          "job-preview-1", 1, 50, null, "asc", { Employee: { contains: "Anil" } },
        ),
      );
      expect(await screen.findByText(/matching rows \/ 5 rows in generated report/)).toBeInTheDocument();
    });

    it("Reset view clears sort/filter and reloads the canonical page 1", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(completedDetailedJob());
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce(baseRows());
      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("Anil Thakor");

      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce({ ...baseRows(), filteredTotalCount: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Debit" }));
      fireEvent.click(await screen.findByRole("button", { name: "Desc" }));
      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
          "job-preview-1", 1, 50, "Debit", "desc", {},
        ),
      );

      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce(baseRows());
      fireEvent.click(await screen.findByRole("button", { name: "Reset view" }));
      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
          "job-preview-1", 1, 50, null, "asc", {},
        ),
      );
      expect(screen.queryByRole("button", { name: "Reset view" })).not.toBeInTheDocument();
    });

    it("never renders Transaction # or Employee ID column filters as money -- they stay plain-text 'contains' controls", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(completedDetailedJob());
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
        ...baseRows(),
        columns: ["Transaction #", "Employee ID", "Debit"],
        rows: [{ "Transaction #": "01090", "Employee ID": "0007", Debit: "₹100.00" }],
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("01090");

      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Transaction #" }));
      expect(await screen.findByPlaceholderText("Contains…")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Min")).not.toBeInTheDocument();
    });
  });

  describe("Preview sort feedback and request ordering (owner QA polish pass)", () => {
    const latest = {
      id: "job-preview-1", status: "completed" as const, progress_current: 5, progress_total: 5,
      filename: "detailed-expense_2026-09-23.csv", storage_path: "org-1/job-preview-1/d.csv",
      file_size_bytes: 8192, error_message_safe: null,
      created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    };
    const page = (names: string[], extra: Record<string, unknown> = {}) => ({
      ready: true as const, reason: null, columns: ["Employee", "Date", "Debit"],
      totalCount: 5, filteredTotalCount: 5, page: 1, pageSize: 50,
      rows: names.map((n, i) => ({ Employee: n, Date: `0${i + 1}-06-2026`, Debit: "₹1.00" })), ...extra,
    });
    const bodyRows = () => screen.getAllByRole("row").slice(1).map((r) => r.querySelector("td")?.textContent);

    it("Date Desc: closes the menu, sends p_sort_column/p_sort_direction, and renders the returned rows in the returned order", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(latest);
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce(page(["First", "Second", "Third"]));
      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("First");
      expect(bodyRows()).toEqual(["First", "Second", "Third"]);

      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce(page(["Third", "Second", "First"]));
      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Date" }));
      fireEvent.click(await screen.findByRole("button", { name: "Desc" }));

      await waitFor(() => expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
        "job-preview-1", 1, 50, "Date", "desc", {},
      ));
      await waitFor(() => expect(bodyRows()).toEqual(["Third", "Second", "First"]));
      // The menu closed on click -- no ambiguity about whether the click worked.
      expect(screen.queryByRole("button", { name: "Desc" })).not.toBeInTheDocument();
      // The header states the sort in an accessible way.
      expect(screen.getByRole("button", { name: "Sort or filter Date" })).toHaveTextContent(/sorted descending/);
    });

    it("keeps the current table on screen with an 'Updating preview…' overlay while a sort is loading (no layout jump)", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(latest);
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce(page(["First", "Second"]));
      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("First");

      let release: (v: unknown) => void = () => {};
      mocked.fetchReportExportJobPreviewPageV2.mockImplementationOnce(() => new Promise((res) => { release = res; }));
      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Employee" }));
      fireEvent.click(await screen.findByRole("button", { name: "Asc" }));

      expect(await screen.findByText("Updating preview…")).toBeInTheDocument();
      expect(screen.getByText("First")).toBeInTheDocument();
      release(page(["Second", "First"]));
      await waitFor(() => expect(screen.queryByText("Updating preview…")).not.toBeInTheDocument());
      expect(bodyRows()).toEqual(["Second", "First"]);
    });

    it("combined filters accumulate (Employee + Expense Type) and a sorted view keeps them; Reset view clears everything", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(latest);
      const cols = ["Employee", "Expense Type", "Date", "Debit"];
      const p = (n: string[]) => ({ ...page(n), columns: cols, rows: n.map((x) => ({ Employee: x, "Expense Type": "Travelling", Date: "01-06-2026", Debit: "₹1.00" })) });
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce(p(["A", "B"]));
      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("A");

      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce({ ...p(["A"]), filteredTotalCount: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Employee" }));
      fireEvent.change(await screen.findByPlaceholderText("Contains…"), { target: { value: "A" } });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
        "job-preview-1", 1, 50, null, "asc", { Employee: { contains: "A" } },
      ));
      await waitFor(() => expect(screen.getByRole("button", { name: "Sort or filter Employee" })).not.toBeDisabled());

      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce({ ...p(["A"]), filteredTotalCount: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Expense Type" }));
      fireEvent.change(await screen.findByPlaceholderText("Contains…"), { target: { value: "Trav" } });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
        "job-preview-1", 1, 50, null, "asc",
        { Employee: { contains: "A" }, "Expense Type": { contains: "Trav" } },
      ));
      await waitFor(() => expect(screen.getByRole("button", { name: "Sort or filter Date" })).not.toBeDisabled());

      // Sorting afterwards keeps BOTH filters.
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce({ ...p(["A"]), filteredTotalCount: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Sort or filter Date" }));
      fireEvent.click(await screen.findByRole("button", { name: "Desc" }));
      await waitFor(() => expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
        "job-preview-1", 1, 50, "Date", "desc",
        { Employee: { contains: "A" }, "Expense Type": { contains: "Trav" } },
      ));

      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce(p(["A", "B"]));
      await waitFor(() => expect(screen.getByRole("button", { name: "Reset view" })).not.toBeDisabled());
      fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
      await waitFor(() => expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
        "job-preview-1", 1, 50, null, "asc", {},
      ));
    });
  });

  describe("Report History 'View' (activePreviewJobId)", () => {
    function historyEntry(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: "hist-1",
        status: "completed" as const,
        filename: "detailed-expense_2026-07-01.csv",
        storage_path: "org-1/hist-1/detailed-expense_2026-07-01.csv",
        file_size_bytes: 2048,
        row_count: 40,
        created_at: "2026-07-01T10:00:00.000Z",
        completed_at: "2026-07-01T10:01:00.000Z",
        expires_at: "2026-07-08T10:00:00.000Z",
        requested_by_name: "Alex",
        requested_by_me: false,
        downloadable: true,
        ...overrides,
      };
    }

    function completedDetailedJob() {
      return {
        id: "job-latest",
        status: "completed" as const,
        progress_current: 5,
        progress_total: 5,
        filename: "detailed-expense_2026-09-23.csv",
        storage_path: "org-1/job-latest/detailed-expense_2026-09-23.csv",
        file_size_bytes: 8192,
        error_message_safe: null,
        created_at: "2026-09-23T10:00:00.000Z",
        completed_at: "2026-09-23T10:01:00.000Z",
      };
    }

    it("clicking View on a history row switches the preview to that job and shows a 'Viewing' badge", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(completedDetailedJob());
      mocked.listReportExportJobsPaged.mockResolvedValue({
        jobs: [historyEntry()],
        totalCount: 1,
        offset: 0,
        limit: 5,
      });
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
        ready: true, reason: null, columns: ["Employee"], totalCount: 1, filteredTotalCount: 1,
        page: 1, pageSize: 50, rows: [{ Employee: "Latest Row" }],
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("detailed-expense_2026-07-01.csv");

      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValueOnce({
        ready: true, reason: null, columns: ["Employee"], totalCount: 40, filteredTotalCount: 40,
        page: 1, pageSize: 50, rows: [{ Employee: "Historical Row" }],
      });

      fireEvent.click(screen.getByRole("button", { name: "View" }));

      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
          "hist-1", 1, 50, null, "asc", {},
        ),
      );
      expect(await screen.findByText("Historical Row")).toBeInTheDocument();
      // Exactly one "Viewing" badge, on the history row itself.
      expect(screen.getAllByText("Viewing")).toHaveLength(1);
    });

    it("View report A then View report B: Download always targets whichever job is currently viewed", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(null);
      mocked.listReportExportJobsPaged.mockResolvedValue({
        jobs: [
          historyEntry({ id: "report-a", filename: "report-a.csv", storage_path: "org-1/report-a.csv" }),
          historyEntry({ id: "report-b", filename: "report-b.csv", storage_path: "org-1/report-b.csv" }),
        ],
        totalCount: 2,
        offset: 0,
        limit: 5,
      });
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
        ready: true, reason: null, columns: ["Employee"], totalCount: 1, filteredTotalCount: 1,
        page: 1, pageSize: 50, rows: [{ Employee: "Row" }],
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      await screen.findByText("report-a.csv");

      const viewButtons = () => screen.getAllByRole("button", { name: "View" });
      fireEvent.click(viewButtons()[0]);
      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
          "report-a", 1, 50, null, "asc", {},
        ),
      );
      fireEvent.click(await screen.findByText("Download CSV"));
      await waitFor(() => expect(mocked.downloadExportJobFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "report-a", storage_path: "org-1/report-a.csv" }),
      ));

      fireEvent.click(viewButtons()[1]);
      await waitFor(() =>
        expect(mocked.fetchReportExportJobPreviewPageV2).toHaveBeenLastCalledWith(
          "report-b", 1, 50, null, "asc", {},
        ),
      );
      fireEvent.click(await screen.findByText("Download CSV"));
      await waitFor(() => expect(mocked.downloadExportJobFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "report-b", storage_path: "org-1/report-b.csv" }),
      ));
    });

    it("shows the honest 'wasn't stored' message for a pre-preview-era history job, without hiding Download", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(null);
      mocked.listReportExportJobsPaged.mockResolvedValue({
        jobs: [historyEntry({ id: "old-job" })],
        totalCount: 1,
        offset: 0,
        limit: 5,
      });
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
        ready: false, reason: "no_preview_available", columns: [], totalCount: 0, filteredTotalCount: 0,
        page: 1, pageSize: 50, rows: [],
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      fireEvent.click(await screen.findByRole("button", { name: "View" }));

      expect(await screen.findByText(
        "Preview wasn't stored for this older report. Download the file to view it.",
      )).toBeInTheDocument();
      expect(screen.getByText("Download")).toBeInTheDocument();
    });

    it("the actively-viewed job's preview survives paging history away from its row", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(null);
      mocked.listReportExportJobsPaged.mockResolvedValueOnce({
        jobs: [historyEntry({ id: "viewed-job" })],
        totalCount: 6,
        offset: 0,
        limit: 5,
      });
      mocked.fetchReportExportJobPreviewPageV2.mockResolvedValue({
        ready: true, reason: null, columns: ["Employee"], totalCount: 1, filteredTotalCount: 1,
        page: 1, pageSize: 50, rows: [{ Employee: "Still Here" }],
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      fireEvent.click(await screen.findByRole("button", { name: "View" }));
      await screen.findByText("Still Here");

      // Page history away -- the viewed job's row is no longer on this page.
      mocked.listReportExportJobsPaged.mockResolvedValueOnce({
        jobs: [historyEntry({ id: "other-job", filename: "other.csv" })],
        totalCount: 6,
        offset: 5,
        limit: 5,
      });
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      await screen.findByText("other.csv");

      // Preview must remain loaded -- never cleared just because its row paged away.
      expect(screen.getByText("Still Here")).toBeInTheDocument();
    });
  });

  describe("Report job lifecycle visibility (MicroLink incident: a report must never silently vanish)", () => {
    function job(overrides: Record<string, unknown> = {}) {
      return {
        id: "job-l1", status: "completed", progress_current: 10, progress_total: 10,
        filename: "claim-approval-list_2026-09-24.csv", storage_path: "org-1/job-l1/x.csv",
        file_size_bytes: 1000, error_message_safe: null,
        created_at: "2026-09-24T10:00:00.000Z", completed_at: "2026-09-24T10:01:00.000Z",
        ...overrides,
      };
    }
    function entry(overrides: Record<string, unknown> = {}) {
      return {
        id: "e1", status: "completed", filename: "r.csv", storage_path: "p", file_size_bytes: 10, row_count: 1,
        created_at: "2026-09-24T10:00:00.000Z", completed_at: "2026-09-24T10:01:00.000Z", expires_at: null,
        requested_by_name: "Sam", requested_by_me: true, downloadable: true, ...overrides,
      };
    }

    it("a FAILED latest job is restored on reload with its safe reason, not 'No reports generated yet'", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(job({
        status: "failed", storage_path: null, filename: null,
        error_message_safe: "Report file integrity check failed: header mismatch.",
      }));
      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      expect(await screen.findByText("Report file integrity check failed: header mismatch.")).toBeInTheDocument();
      expect(screen.getByText("Try again")).toBeInTheDocument();
    });

    it("a QUEUED latest job is restored as 'Queued' and blocks a duplicate Generate", async () => {
      const queued = job({ status: "queued", storage_path: null, filename: null, progress_total: null });
      mocked.fetchLatestExportJob.mockResolvedValue(queued);
      mocked.fetchExportJob.mockResolvedValue(queued);
      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      expect(await screen.findByText("Queued — waiting to start…")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Generating on server/ })).toBeDisabled();
    });

    it("a RUNNING latest job is restored with live progress", async () => {
      const running = job({ status: "running", progress_current: 40, progress_total: 100, storage_path: null, filename: null });
      mocked.fetchLatestExportJob.mockResolvedValue(running);
      mocked.fetchExportJob.mockResolvedValue(running);
      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      expect(await screen.findByText("Generating… 40 of 100 rows")).toBeInTheDocument();
    });

    it("history shows Failed with the safe reason and Retry; Retry re-enqueues with that job's own frozen parameters", async () => {
      const frozen = { category: "Travelling", date_from: "2026-08-01", date_to: "2026-08-31" };
      mocked.listReportExportJobsPaged.mockResolvedValue({
        jobs: [entry({ id: "f1", status: "failed", downloadable: false, storage_path: null, filename: null, parameters: frozen, error_message_safe: "The report worker stopped responding." })],
        totalCount: 1, offset: 0, limit: 5,
      });
      mocked.retryReportExportJob.mockResolvedValue({ job_id: "retry-job", status: "queued", deduplicated: false });
      mocked.fetchExportJob.mockResolvedValue(job({ id: "retry-job", status: "queued", storage_path: null, filename: null }));
      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);

      expect(await screen.findByText("Failed")).toBeInTheDocument();
      expect(screen.getByText("The report worker stopped responding.")).toBeInTheDocument();
      expect(screen.queryByText("Download")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(mocked.retryReportExportJob).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: "org-1", reportType: "claim_approval", parameters: frozen }),
      ));
      await waitFor(() => expect(mocked.triggerExportWorker).toHaveBeenCalledWith("retry-job"));
    });

    it("history shows Queued and Generating rows with progress and no Download or View for them", async () => {
      mocked.listReportExportJobsPaged.mockResolvedValue({
        jobs: [
          entry({ id: "q1", status: "queued", downloadable: false, filename: null }),
          entry({ id: "r1", status: "running", downloadable: false, filename: null, progress_current: 5, progress_total: 20 }),
        ],
        totalCount: 2, offset: 0, limit: 5,
      });
      render(<ServerReportExportPanel {...baseProps()} reportType="detailed_expense" />);
      expect(await screen.findByText("Queued")).toBeInTheDocument();
      expect(screen.getByText("Generating")).toBeInTheDocument();
      expect(screen.getByText("Waiting to start")).toBeInTheDocument();
      expect(screen.getByText("Generating… 5 / 20")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
      expect(screen.queryByText("Download")).not.toBeInTheDocument();
    });

    it("Generate nudges the worker for its OWN job id, never a bare global drain", async () => {
      mocked.enqueueExpenseReportExport.mockResolvedValue({ job_id: "job-mine", status: "queued", deduplicated: false });
      mocked.fetchExportJob.mockResolvedValue(job({ id: "job-mine", status: "queued", storage_path: null, filename: null }));
      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      fireEvent.click(await screen.findByRole("button", { name: "Generate report" }));
      await waitFor(() => expect(mocked.triggerExportWorker).toHaveBeenCalledWith("job-mine"));
    });

    it("a completed report with zero rows says so explicitly instead of looking broken", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(job({ progress_current: 0, progress_total: 0 }));
      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      expect(await screen.findByText("Completed with 0 rows — no rows matched these filters.")).toBeInTheDocument();
    });

    it("claim reports state that having no preview is normal (success = row count + Download)", async () => {
      mocked.fetchLatestExportJob.mockResolvedValue(job());
      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      expect(await screen.findByText(/no on-page preview/)).toBeInTheDocument();
    });

    it("switching organization drops the previous organization's report and history", async () => {
      mocked.fetchLatestExportJob.mockResolvedValueOnce(job({ filename: "org-one-report.csv" }));
      mocked.listReportExportJobsPaged.mockResolvedValueOnce({
        jobs: [entry({ id: "org1-h", filename: "org-one-history.csv" })], totalCount: 1, offset: 0, limit: 5,
      });
      const { rerender } = render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      expect(await screen.findByText("org-one-history.csv")).toBeInTheDocument();
      expect(screen.getByText("Download CSV")).toBeInTheDocument();

      mocked.fetchLatestExportJob.mockResolvedValue(null);
      mocked.listReportExportJobsPaged.mockResolvedValue({ jobs: [], totalCount: 0, offset: 0, limit: 5 });
      rerender(<ServerReportExportPanel {...baseProps()} organizationId="org-2" reportType="claim_approval" />);

      await waitFor(() => expect(screen.queryByText("org-one-history.csv")).not.toBeInTheDocument());
      expect(screen.queryByText("Download CSV")).not.toBeInTheDocument();
      expect(screen.queryByText(/org-one-report/)).not.toBeInTheDocument();
    });
  });

  describe("Report history pagination (DOC-131)", () => {
    it("shows a Previous/Page X of Y/Next pager only when there is more than one page", async () => {
      mocked.listReportExportJobsPaged.mockResolvedValue({
        jobs: [{
          id: "h10", status: "completed", filename: "r.csv", storage_path: "p", file_size_bytes: 10,
          row_count: 1, created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
          expires_at: null, requested_by_name: "Sam", requested_by_me: true, downloadable: true,
        }],
        totalCount: 12,
        offset: 0,
        limit: 5,
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);

      expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    });

    it("clicking Next fetches the next 5-row offset", async () => {
      mocked.listReportExportJobsPaged.mockResolvedValue({
        jobs: [{
          id: "h11", status: "completed", filename: "r.csv", storage_path: "p", file_size_bytes: 10,
          row_count: 1, created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
          expires_at: null, requested_by_name: "Sam", requested_by_me: true, downloadable: true,
        }],
        totalCount: 12,
        offset: 0,
        limit: 5,
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      await screen.findByText("Page 1 of 3");

      const nextButtons = await screen.findAllByRole("button", { name: "Next page" });
      fireEvent.click(nextButtons[nextButtons.length - 1]);

      await waitFor(() =>
        expect(mocked.listReportExportJobsPaged).toHaveBeenCalledWith("org-1", "claim_approval", 5, 5),
      );
    });

    it("has no pager at all when everything fits on one page", async () => {
      mocked.listReportExportJobsPaged.mockResolvedValue({
        jobs: [{
          id: "h12", status: "completed", filename: "r.csv", storage_path: "p", file_size_bytes: 10,
          row_count: 1, created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
          expires_at: null, requested_by_name: "Sam", requested_by_me: true, downloadable: true,
        }],
        totalCount: 1,
        offset: 0,
        limit: 5,
      });

      render(<ServerReportExportPanel {...baseProps()} reportType="claim_approval" />);
      await screen.findByText("r.csv");

      expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument();
    });
  });

  it("the PesoWise-Tally sync control is rendered only for Detailed Expense (flag VITE_PWT_SYNC is build-time, so checked in source)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/ServerReportExportPanel.tsx"), "utf8");
    expect(src).toContain(`enableTallySync && PWT_SYNC_ENABLED && reportType === "detailed_expense"`);
  });
});
