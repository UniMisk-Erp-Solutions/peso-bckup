/**
 * Server-generated report exports.
 *
 * The browser does not build the report. It enqueues a job, asks the worker to
 * run, polls the job row, and is handed a download URL. Nothing is assembled,
 * held in memory, or serialised client-side.
 */
import { supabase } from "@/integrations/supabase/client";

/**
 * `src/integrations/supabase/types.ts` is generated and predates
 * `report_export_jobs` and its RPCs, so the typed client rejects them by name.
 * Regenerating that file touches thousands of lines and is a separate change;
 * this narrow, commented escape matches how the rest of the codebase already
 * reaches newer objects (see AuthContext.tsx).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ExportJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ExportJob {
  id: string;
  status: ExportJobStatus;
  progress_current: number;
  progress_total: number | null;
  filename: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
  error_message_safe: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface EnqueueResult {
  job_id: string;
  status: ExportJobStatus;
  deduplicated: boolean;
}

/** Enqueue. The server dedupes an identical request that is still queued/running. */
export async function enqueueDailyProjectReportExport(input: {
  organizationId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  userId?: string | null;
  userIds?: string[] | null;
  teamScoped?: boolean;
  format?: "csv" | "xlsx";
}): Promise<EnqueueResult> {
  const { data, error } = await db.rpc("create_daily_project_report_export_job_v1", {
    p_organization_id: input.organizationId,
    p_date_from: input.dateFrom ?? null,
    p_date_to: input.dateTo ?? null,
    // "all" is the Employee filter's "no filter" sentinel value (see
    // Reports.tsx's selectedEmployee state), not a real user id -- passing
    // it straight through as p_user_id (a uuid column) fails with
    // `invalid input syntax for type uuid: "all"`. enqueueExpenseReportExport
    // below already guards against this same sentinel; this path needs the
    // identical guard.
    p_user_id: input.userId && input.userId !== "all" ? input.userId : null,
    p_team_scoped: input.teamScoped ?? false,
    p_user_ids: input.userIds ?? null,
    p_format: input.format ?? "csv",
  });
  if (error) throw new Error(error.message);
  return data as unknown as EnqueueResult;
}

export type ExpenseReportType =
  | "claim_verification"
  | "claim_approval"
  | "detailed_expense";

/**
 * Enqueue Claim Verification / Claim Approval / Detailed Expense.
 *
 * Filters go over as one jsonb blob and form the dedupe key, so two people
 * asking for the same report while it is still running share a single job.
 */
export async function enqueueExpenseReportExport(input: {
  organizationId: string;
  reportType: ExpenseReportType;
  category?: string | null;
  userId?: string | null;
  userIds?: string[] | null;
  engineerStatus?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  teamScoped?: boolean;
  /** Detailed Expense only: stable custom-field label -> selected value. Frozen into this job's own parameters at enqueue time. */
  customFieldFilters?: Record<string, string>;
  /**
   * Detailed Expense only: the raw Year/Month/Week selector values (not just
   * the resolved date_from/date_to) -- stored so a later history summary can
   * say "Week 23" or "June 2026" without guessing it back out of a date
   * range, and so it stays frozen even if the caller's own filter controls
   * change afterward.
   */
  selectedYear?: string;
  selectedMonth?: string;
  selectedWeek?: string;
}): Promise<EnqueueResult> {
  const filters: Record<string, unknown> = {};
  if (input.category && input.category !== "all") filters.category = input.category;
  if (input.userId && input.userId !== "all") filters.user_id = input.userId;
  if (input.userIds?.length) filters.user_ids = input.userIds;
  if (input.engineerStatus && input.engineerStatus !== "all") {
    filters.engineer_status = input.engineerStatus;
  }
  if (input.dateFrom) filters.date_from = input.dateFrom;
  if (input.dateTo) filters.date_to = input.dateTo;
  if (input.customFieldFilters && Object.keys(input.customFieldFilters).length) {
    filters.custom_field_filters = input.customFieldFilters;
  }
  if (input.selectedYear) filters.year = input.selectedYear;
  if (input.selectedMonth && input.selectedMonth !== "all") filters.month = input.selectedMonth;
  if (input.selectedWeek && input.selectedWeek !== "all") filters.week = input.selectedWeek;

  const { data, error } = await db.rpc("create_expense_report_export_job_v1", {
    p_organization_id: input.organizationId,
    p_report_type: input.reportType,
    p_filters: filters,
    p_team_scoped: input.teamScoped ?? false,
    p_format: "csv",
  });
  if (error) throw new Error(error.message);
  return data as unknown as EnqueueResult;
}

/**
 * Retry a failed/cancelled report with the SAME frozen parameters it was
 * originally enqueued with (never today's filter controls). Creates a brand
 * new job -- a finished job is never mutated -- and the server's normal dedupe
 * still collapses it into an identical job that is already queued/running.
 */
export async function retryReportExportJob(input: {
  organizationId: string;
  reportType: string;
  parameters: Record<string, unknown> | undefined;
  teamScoped: boolean;
}): Promise<EnqueueResult> {
  const params = input.parameters ?? {};
  if (input.reportType === "daily_project_report") {
    return enqueueDailyProjectReportExport({
      organizationId: input.organizationId,
      dateFrom: typeof params.date_from === "string" ? params.date_from : null,
      dateTo: typeof params.date_to === "string" ? params.date_to : null,
      userId: typeof params.user_id === "string" ? params.user_id : null,
      userIds: Array.isArray(params.user_ids) ? (params.user_ids as string[]) : null,
      teamScoped: input.teamScoped,
      format: "csv",
    });
  }
  const { data, error } = await db.rpc("create_expense_report_export_job_v1", {
    p_organization_id: input.organizationId,
    p_report_type: input.reportType,
    p_filters: params,
    p_team_scoped: input.teamScoped,
    p_format: "csv",
  });
  if (error) throw new Error(error.message);
  return data as unknown as EnqueueResult;
}

/**
 * Ask the worker to drain the queue.
 *
 * Deliberately best-effort: if this fails the job stays `queued` and any later
 * invocation (another user generating, or a scheduled drain) still picks it up.
 * Treating a transient invoke failure as a job failure would be wrong — the job
 * is fine, only this nudge was lost.
 */
export async function triggerExportWorker(jobId?: string): Promise<void> {
  try {
    // With a job id the worker claims THAT job (claim_report_export_job_v2)
    // instead of the globally oldest queued one, so a click on Generate can
    // never end up serving another organization's backlog. Without one (the
    // cron backstop's shape) it keeps draining the global queue.
    await supabase.functions.invoke("run-report-export-job", { body: jobId ? { job_id: jobId } : {} });
  } catch {
    /* the job remains claimable */
  }
}

export async function fetchExportJob(jobId: string): Promise<ExportJob | null> {
  const { data, error } = await db
    .from("report_export_jobs")
    .select(
      "id, status, progress_current, progress_total, filename, storage_path, file_size_bytes, error_message_safe, created_at, completed_at",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as unknown as ExportJob | null;
}

/** Most recent job for this org, so a finished report survives a page reload. */
export async function fetchLatestExportJob(
  organizationId: string,
  reportType = "daily_project_report",
): Promise<ExportJob | null> {
  const { data, error } = await db
    .from("report_export_jobs")
    .select(
      "id, status, progress_current, progress_total, filename, storage_path, file_size_bytes, error_message_safe, created_at, completed_at",
    )
    .eq("organization_id", organizationId)
    .eq("report_type", reportType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as unknown as ExportJob | null;
}

/**
 * Download the finished file.
 *
 * The browser does not sign the Storage object itself. It asks a server-side
 * function to do it, sending only the job id -- never a bucket/path/filename
 * it could tamper with. That function re-derives the SAME authorization the
 * job-creation RPCs already used (daily_report_caller_can_view_v1, called
 * with the job's own stored team_scoped value), so there is one source of
 * report authorization rather than a second copy of the rule living in a
 * Storage RLS policy that can drift from it.
 *
 * HOTFIX 2026-09: the previous implementation called
 * `storage.from(BUCKET).createSignedUrl(...)` directly with the caller's own
 * JWT. The only storage.objects SELECT policy for this bucket hard-codes
 * team_scoped=false, so a Manager/Executive correctly authorized to GENERATE
 * a team-scoped report was denied at DOWNLOAD time -- reproduced live
 * against a real team-scoped Daily Project Report as a non-admin role.
 *
 * Still uses a signed URL for the actual transfer, so the browser streams
 * straight from Storage to disk and a large report never occupies a JS buffer.
 */
export async function downloadExportJobFile(job: ExportJob): Promise<void> {
  if (!job.id) throw new Error("This report has no file yet.");

  const { data, error } = await supabase.functions.invoke<{
    signedUrl?: string;
    filename?: string;
    error?: string;
  }>("get-report-export-download-url", { body: { job_id: job.id } });

  if (error) {
    throw new Error(
      "The report file is temporarily unavailable. Please try again in a moment.",
    );
  }
  if (data?.error) throw new Error(data.error);
  if (!data?.signedUrl) throw new Error("Could not create a download link.");

  const a = document.createElement("a");
  a.href = data.signedUrl;
  a.download = data.filename ?? job.filename ?? "daily-project-report.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface ExportHistoryEntry {
  id: string;
  status: ExportJobStatus;
  filename: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
  row_count: number | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  requested_by_name: string;
  requested_by_me: boolean;
  /** False once the file has expired or been purged — do not offer a download. */
  downloadable: boolean;
  /**
   * Frozen exactly as this job was enqueued with (create_expense_report_export_job_v1's
   * p_filters, stored verbatim) — only present via list_report_export_jobs_v3.
   * Never re-derive a history row's summary from the CALLER's current filter
   * controls; this is the one source of truth for what THAT job actually used.
   */
  parameters?: Record<string, unknown>;
  /** Server-resolved "Name (EMP-CODE)" for a single-employee job, or null for "all employees" / v2. Never a raw UUID. */
  employee_display?: string | null;
  /** v4 only: live progress for queued/running jobs. */
  progress_current?: number | null;
  progress_total?: number | null;
  started_at?: string | null;
  /** v4 only: the sanitised reason, present for failed jobs only. */
  error_message_safe?: string | null;
  /** v4 only: a running job whose worker stopped heart-beating. */
  stale?: boolean;
  /** v4 only: whether a frozen on-page preview was stored for this job. */
  has_preview?: boolean;
}

/**
 * Who generated this report, when, and can the file still be had.
 *
 * Scoped to one report type so each tab shows only its own history.
 */
export async function listReportExportJobs(
  organizationId: string,
  reportType = "daily_project_report",
  limit = 20,
): Promise<ExportHistoryEntry[]> {
  const { data, error } = await db.rpc("list_report_export_jobs_v1", {
    p_organization_id: organizationId,
    p_report_type: reportType,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  const payload = data as { jobs?: ExportHistoryEntry[] } | null;
  return payload?.jobs ?? [];
}

/** Download a historical entry — same server-signed path as a fresh report. */
export async function downloadHistoryEntry(entry: ExportHistoryEntry): Promise<void> {
  await downloadExportJobFile({
    id: entry.id,
    storage_path: entry.storage_path,
    filename: entry.filename,
  } as ExportJob);
}

export function isTerminalStatus(s: ExportJobStatus): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Paginated history (DOC-131). Same envelope as `listReportExportJobs`
 * (`list_report_export_jobs_v1`, untouched — still used wherever a plain,
 * unpaginated top-N list is wanted), plus a real `total_count` so the caller
 * can render "Page X of Y" instead of guessing from the page's row count.
 */
export interface ExportHistoryPage {
  jobs: ExportHistoryEntry[];
  totalCount: number;
  offset: number;
  limit: number;
}

const HISTORY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-01" -> "01 Jun 2026". Pure string math -- never a Date/timezone parse of a date-only value. */
function formatDMonYYYY(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;
  const monthName = HISTORY_MONTHS[parseInt(mo, 10) - 1];
  if (!monthName) return null;
  return `${d} ${monthName} ${y}`;
}

export interface HistoryParameterSummary {
  /** "Sagar Patel (5540)" or "All employees". */
  employeeLine: string;
  /** "01 Jun 2026 – 30 Jun 2026" or "All time". */
  rangeLine: string;
  /** e.g. ["Expense Type: Fuel", "Week: 23", "Project ID: P101"] -- only parameters actually set on THIS job. */
  chips: string[];
}

/**
 * Builds the small, human-readable per-job summary for Report History rows.
 * Reads ONLY `entry.parameters` -- the job's own frozen filter snapshot from
 * enqueue time -- never anything from the caller's current filter controls,
 * so changing today's filters can never alter an old history row's summary.
 * Returns null for a job with no stored parameters at all (a v1/v2 caller,
 * or a job that predates this feature) -- the whole section is omitted
 * rather than shown blank.
 */
export function formatHistoryParameterSummary(
  entry: ExportHistoryEntry,
): HistoryParameterSummary | null {
  const params = entry.parameters;
  if (!params) return null;

  const employeeLine = entry.employee_display || "All employees";

  const dateFrom = typeof params.date_from === "string" ? params.date_from : null;
  const dateTo = typeof params.date_to === "string" ? params.date_to : null;
  const rangeLine = dateFrom && dateTo
    ? `${formatDMonYYYY(dateFrom) ?? dateFrom} – ${formatDMonYYYY(dateTo) ?? dateTo}`
    : "All time";

  const chips: string[] = [];
  const category = typeof params.category === "string" ? params.category : null;
  chips.push(`Expense Type: ${category || "All"}`);
  const week = typeof params.week === "string" || typeof params.week === "number" ? String(params.week) : null;
  if (week) chips.push(`Week: ${week}`);
  const customFieldFilters =
    params.custom_field_filters && typeof params.custom_field_filters === "object"
      ? (params.custom_field_filters as Record<string, string>)
      : null;
  if (customFieldFilters) {
    for (const [label, value] of Object.entries(customFieldFilters)) {
      if (!value || value === "all") continue;
      chips.push(`${label}: ${value}`);
    }
  }

  return { employeeLine, rangeLine, chips };
}

export async function listReportExportJobsPaged(
  organizationId: string,
  reportType: string,
  offset: number,
  limit = 5,
): Promise<ExportHistoryPage> {
  // v4: every lifecycle state (queued/running/completed/failed/cancelled),
  // not just completed -- a failed or still-running job must be visible in
  // history instead of looking like "nothing happened". v1-v3 are untouched
  // and still usable by anything that only wants completed jobs.
  const { data, error } = await db.rpc("list_report_export_jobs_v4", {
    p_organization_id: organizationId,
    p_report_type: reportType,
    p_offset: offset,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  const payload = data as {
    jobs?: ExportHistoryEntry[];
    total_count?: number;
    offset?: number;
    limit?: number;
  } | null;
  return {
    jobs: payload?.jobs ?? [],
    totalCount: payload?.total_count ?? 0,
    offset: payload?.offset ?? offset,
    limit: payload?.limit ?? limit,
  };
}

/**
 * On-page preview of a completed Detailed Expense report (DOC-131).
 *
 * Reads the EXACT rows frozen at generation time (report_export_job_rows) --
 * never a live re-query — so the preview can never drift from the file the
 * user can download. `ready: false` means "nothing to show yet", not an
 * error: still generating, or this job type/vintage never got a stored
 * preview (e.g. Claim Verification/Approval, or a job from before this
 * feature existed). Callers should hide the preview UI rather than surface a
 * scary error in that case.
 */
export interface ReportPreviewPage {
  ready: boolean;
  reason: "not_completed" | "no_preview_available" | null;
  columns: string[];
  totalCount: number;
  page: number;
  pageSize: number;
  rows: Record<string, string>[];
}

export async function fetchReportExportJobPreviewPage(
  jobId: string,
  page: number,
  pageSize = 50,
): Promise<ReportPreviewPage> {
  const { data, error } = await db.rpc("get_report_export_job_preview_v1", {
    p_job_id: jobId,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) throw new Error(error.message);
  const payload = data as {
    ready?: boolean;
    reason?: "not_completed" | "no_preview_available" | null;
    columns?: string[];
    total_count?: number;
    page?: number;
    page_size?: number;
    rows?: Record<string, string>[];
  } | null;
  return {
    ready: payload?.ready ?? false,
    reason: payload?.reason ?? null,
    columns: payload?.columns ?? [],
    totalCount: payload?.total_count ?? 0,
    page: payload?.page ?? page,
    pageSize: payload?.page_size ?? pageSize,
    rows: payload?.rows ?? [],
  };
}

/**
 * Excel-style column classification for the preview grid (DOC-131 follow-up).
 * Deliberately keyed on the report's own FIXED column names only — every
 * dynamic custom-field column (which varies per organization) falls through
 * to "text". Kept in sync by hand with the identical CASE expression inside
 * `get_report_export_job_preview_v2` (supabase/migrations/20260930000000_...);
 * the call itself now goes to v3 (20261002000000_...): same contract, blanks sorted
 * last, case-insensitive text, parse-safe.
 */
export type PreviewColumnKind = "date" | "money" | "text";

export function classifyPreviewColumnKind(column: string): PreviewColumnKind {
  if (column === "Date") return "date";
  if (column === "Credit" || column === "Debit" || column === "Opening Balance" || column === "Closing Balance") {
    return "money";
  }
  return "text";
}

/**
 * One column's active filter. Only the key(s) relevant to that column's kind
 * are ever set (text -> contains, date -> from/to, money -> min/max) --
 * mirrors the jsonb-key-existence checks in get_report_export_job_preview_v2
 * exactly, so a filter built here is never silently ignored server-side.
 */
export interface ColumnFilterSpec {
  contains?: string;
  from?: string;
  to?: string;
  min?: number;
  max?: number;
}

export type SortDirection = "asc" | "desc";

export interface ReportPreviewPageV2 extends ReportPreviewPage {
  /** Rows matching the active filters (before pagination) -- equals totalCount when no filter is set. */
  filteredTotalCount: number;
}

/**
 * v2: same frozen `report_export_job_rows` source as v1, plus server-side
 * Excel-style sort/filter over the ENTIRE frozen report (never just the
 * rendered page). v1 is untouched and still used wherever no sort/filter is
 * needed.
 */
export async function fetchReportExportJobPreviewPageV2(
  jobId: string,
  page: number,
  pageSize = 50,
  sortColumn: string | null = null,
  sortDirection: SortDirection = "asc",
  columnFilters: Record<string, ColumnFilterSpec> | null = null,
): Promise<ReportPreviewPageV2> {
  const { data, error } = await db.rpc("get_report_export_job_preview_v3", {
    p_job_id: jobId,
    p_page: page,
    p_page_size: pageSize,
    p_sort_column: sortColumn,
    p_sort_direction: sortDirection,
    p_column_filters: columnFilters && Object.keys(columnFilters).length ? columnFilters : null,
  });
  if (error) throw new Error(error.message);
  const payload = data as {
    ready?: boolean;
    reason?: "not_completed" | "no_preview_available" | null;
    columns?: string[];
    total_count?: number;
    filtered_total_count?: number;
    page?: number;
    page_size?: number;
    rows?: Record<string, string>[];
  } | null;
  return {
    ready: payload?.ready ?? false,
    reason: payload?.reason ?? null,
    columns: payload?.columns ?? [],
    totalCount: payload?.total_count ?? 0,
    filteredTotalCount: payload?.filtered_total_count ?? payload?.total_count ?? 0,
    page: payload?.page ?? page,
    pageSize: payload?.page_size ?? pageSize,
    rows: payload?.rows ?? [],
  };
}
