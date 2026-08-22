/**
 * DOC-104 — server-generated Daily Project Report.
 *
 * Click Generate, the server builds the whole CSV, the UI shows a Download
 * button. The browser never assembles the report: it enqueues a job, polls a
 * status row, and downloads the finished file straight from Storage via a
 * signed URL, so even a multi-megabyte export never passes through a JS buffer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, AlertCircle, FileSpreadsheet, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  enqueueDailyProjectReportExport,
  triggerExportWorker,
  fetchExportJob,
  fetchLatestExportJob,
  downloadExportJobFile,
  isTerminalStatus,
  formatBytes,
  enqueueExpenseReportExport,
  type ExportJob,
  type ExpenseReportType,
} from "@/lib/reportExportJobs";

interface ServerReportExportPanelProps {
  organizationId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  userId: string | null;
  userIds: string[] | null;
  teamScoped: boolean;
  disabled?: boolean;
  /** Omitted = the Daily Project Report (DOC-104). */
  reportType?: ExpenseReportType;
  /** Only meaningful for the expense-based reports (DOC-105). */
  category?: string | null;
  engineerStatus?: string | null;
}

const POLL_MS = 2000;
/** Give up polling after this long; the job itself keeps running server-side. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export function ServerReportExportPanel({
  organizationId,
  dateFrom,
  dateTo,
  userId,
  userIds,
  teamScoped,
  disabled = false,
  reportType,
  category,
  engineerStatus,
}: ServerReportExportPanelProps) {
  const { toast } = useToast();
  const [job, setJob] = useState<ExportJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // A finished report should survive a reload — otherwise the user regenerates
  // something the server already has sitting in Storage.
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const latest = await fetchLatestExportJob(
          organizationId,
          reportType ?? "daily_project_report",
        );
        if (!cancelled && latest && latest.status === "completed") setJob(latest);
      } catch {
        /* a missing previous job is not an error worth surfacing */
      }
    })();
    return () => { cancelled = true; };
  }, [organizationId, reportType]);

  const poll = useCallback(
    (jobId: string) => {
      stopPolling();
      startedAtRef.current = Date.now();
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
          stopPolling();
          setError("Still generating. Reopen this page shortly to collect the file.");
          return;
        }
        try {
          const next = await fetchExportJob(jobId);
          if (!next) return;
          setJob(next);
          if (isTerminalStatus(next.status)) {
            stopPolling();
            if (next.status === "failed") {
              setError(next.error_message_safe || "The report could not be generated.");
            }
          }
        } catch {
          /* transient poll failure — the next tick retries */
        }
      }, POLL_MS);
    },
    [stopPolling],
  );

  const generate = async () => {
    if (!organizationId) return;
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const res = reportType
        ? await enqueueExpenseReportExport({
            organizationId, reportType, category, userId, userIds,
            engineerStatus, dateFrom, dateTo, teamScoped,
          })
        : await enqueueDailyProjectReportExport({
            organizationId, dateFrom, dateTo, userId, userIds, teamScoped, format: "csv",
          });
      // Nudge the worker, then poll regardless of whether the nudge landed.
      void triggerExportWorker();
      const initial = await fetchExportJob(res.job_id);
      if (initial) setJob(initial);
      poll(res.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the report.");
    } finally {
      setStarting(false);
    }
  };

  const download = async () => {
    if (!job) return;
    setDownloading(true);
    try {
      await downloadExportJobFile(job);
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof Error ? err.message : "Could not download the file.",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };

  const busy = starting || (job != null && !isTerminalStatus(job.status));
  const ready = job?.status === "completed" && job.storage_path;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Generate report</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        The report is built on the server. When it is ready, download it as a CSV.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void generate()} disabled={disabled || busy || !organizationId}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {busy ? "Generating on server…" : "Generate report"}
        </Button>

        {ready && (
          <Button variant="default" onClick={() => void download()} disabled={downloading}>
            {downloading
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Download className="mr-2 h-4 w-4" />}
            Download CSV
          </Button>
        )}

        {job?.status === "failed" && (
          <Button variant="outline" onClick={() => void generate()}>
            <RotateCw className="mr-2 h-4 w-4" />
            Try again
          </Button>
        )}
      </div>

      {busy && job && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {job.progress_total
            ? `Building ${job.progress_current.toLocaleString()} of ${job.progress_total.toLocaleString()} rows…`
            : "Preparing…"}
        </p>
      )}

      {ready && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {job.filename}
          {job.progress_total ? ` · ${job.progress_total.toLocaleString()} rows` : ""}
          {job.file_size_bytes ? ` · ${formatBytes(job.file_size_bytes)}` : ""}
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
