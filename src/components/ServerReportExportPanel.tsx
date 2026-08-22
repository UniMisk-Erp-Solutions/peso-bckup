/**
 * DOC-104 — server-generated Daily Project Report.
 *
 * Click Generate, the server builds the whole CSV, the UI shows a Download
 * button. The browser never assembles the report: it enqueues a job, polls a
 * status row, and downloads the finished file straight from Storage via a
 * signed URL, so even a multi-megabyte export never passes through a JS buffer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download, Loader2, AlertCircle, FileSpreadsheet, RotateCw, History,
} from "lucide-react";
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
  listReportExportJobs,
  downloadHistoryEntry,
  type ExportJob,
  type ExpenseReportType,
  type ExportHistoryEntry,
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
  const [history, setHistory] = useState<ExportHistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const effectiveType = reportType ?? "daily_project_report";

  // DOC-106 — every generated report leaves a row; this surfaces them so an
  // earlier file can be re-downloaded instead of regenerated.
  const loadHistory = useCallback(async () => {
    if (!organizationId) return;
    try {
      setHistory(await listReportExportJobs(organizationId, effectiveType, 20));
    } catch {
      /* history is supplementary; a failure here must not block generating */
    }
  }, [organizationId, effectiveType]);

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
        if (!cancelled) await loadHistory();
      } catch {
        /* a missing previous job is not an error worth surfacing */
      }
    })();
    return () => { cancelled = true; };
  }, [organizationId, reportType, loadHistory]);

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
            void loadHistory();
            if (next.status === "failed") {
              setError(next.error_message_safe || "The report could not be generated.");
            }
          }
        } catch {
          /* transient poll failure — the next tick retries */
        }
      }, POLL_MS);
    },
    [stopPolling, loadHistory],
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

  const downloadOld = async (entry: ExportHistoryEntry) => {
    setHistoryBusy(entry.id);
    try {
      await downloadHistoryEntry(entry);
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof Error ? err.message : "Could not download that report.",
        variant: "destructive",
      });
      // The file may have just expired; refresh so the row stops offering it.
      void loadHistory();
    } finally {
      setHistoryBusy(null);
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

      {/* DOC-106 — generation history for THIS report type. */}
      <div className="border-t pt-3 space-y-2">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Report history</h4>
        </div>

        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reports generated yet. Generated reports appear here and stay
            downloadable until they expire.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {history.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {h.filename ?? "report.csv"}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {formatGeneratedAt(h.created_at)}
                    {" · "}
                    {h.requested_by_me ? "You" : h.requested_by_name}
                    {h.row_count ? ` · ${h.row_count.toLocaleString()} rows` : ""}
                    {h.file_size_bytes ? ` · ${formatBytes(h.file_size_bytes)}` : ""}
                  </p>
                </div>

                {h.downloadable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void downloadOld(h)}
                    disabled={historyBusy === h.id}
                  >
                    {historyBusy === h.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-2 h-4 w-4" />
                    )}
                    Download
                  </Button>
                ) : (
                  // The row stays visible as a record of who generated what,
                  // but the file is gone, so no button that would 404.
                  <span className="text-xs text-muted-foreground">
                    File expired
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** e.g. "22 Aug 2026, 4:35 pm" — local time, matching the app's date style. */
function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
