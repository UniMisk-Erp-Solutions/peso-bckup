/**
 * DOC-104 — server-generated report exports.
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

const BUCKET = "generated-reports";

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
    p_user_id: input.userId ?? null,
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
 * DOC-105 — enqueue Claim Verification / Claim Approval / Detailed Expense.
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
 * Ask the worker to drain the queue.
 *
 * Deliberately best-effort: if this fails the job stays `queued` and any later
 * invocation (another user generating, or a scheduled drain) still picks it up.
 * Treating a transient invoke failure as a job failure would be wrong — the job
 * is fine, only this nudge was lost.
 */
export async function triggerExportWorker(): Promise<void> {
  try {
    await supabase.functions.invoke("run-report-export-job", { body: {} });
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
 * Uses a signed URL rather than pulling bytes through JS: the browser streams
 * straight from Storage to disk, so a large report never occupies a JS buffer.
 */
export async function downloadExportJobFile(job: ExportJob): Promise<void> {
  if (!job.storage_path) throw new Error("This report has no file yet.");

  const { data, error } = await db.storage
    .from(BUCKET)
    .createSignedUrl(job.storage_path, 120, {
      download: job.filename ?? "daily-project-report.csv",
    });
  if (error) throw new Error(error.message);
  if (!data?.signedUrl) throw new Error("Could not create a download link.");

  const a = document.createElement("a");
  a.href = data.signedUrl;
  a.download = job.filename ?? "daily-project-report.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
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
