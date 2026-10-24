/**
 * Server-generated report for all four Reports tabs.
 *
 * Click Generate, the server builds the whole CSV, the UI shows a Download
 * button. The browser never assembles the report: it enqueues a job, polls a
 * status row, and downloads the finished file straight from Storage via a
 * signed URL, so even a multi-megabyte export never passes through a JS buffer.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Download, Loader2, AlertCircle, FileSpreadsheet, RotateCw, History, ChevronLeft, ChevronRight, Table as TableIcon,
  ArrowUp, ArrowDown, Filter, X, Eye, RefreshCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { createMonthFetchGuardState, invalidateMonthFetch, runMonthFetch } from "@/lib/monthFetchGuard";
import {
  enqueueDailyProjectReportExport,
  triggerExportWorker,
  fetchExportJob,
  fetchLatestExportJob,
  downloadExportJobFile,
  isTerminalStatus,
  formatBytes,
  enqueueExpenseReportExport,
  listReportExportJobsPaged,
  downloadHistoryEntry,
  fetchReportExportJobPreviewPageV2,
  formatHistoryParameterSummary,
  classifyPreviewColumnKind,
  retryReportExportJob,
  type ExportJob,
  type ExpenseReportType,
  type ExportHistoryEntry,
  type ReportPreviewPageV2,
  type ColumnFilterSpec,
  type SortDirection,
} from "@/lib/reportExportJobs";
import { PwtSyncGroup } from "@/components/PwtSyncControl";

/** PesoWise -> TallyPrime "Sync to Tally" control on the four reports; off unless VITE_PWT_SYNC=1. */
const PWT_SYNC_ENABLED = import.meta.env.VITE_PWT_SYNC === "1";

const HISTORY_PAGE_SIZE = 5;
const PREVIEW_PAGE_SIZE = 50;

/** Does this column currently have any filter key set? */
function isFilterActive(spec: ColumnFilterSpec | undefined): boolean {
  if (!spec) return false;
  return spec.contains !== undefined || spec.from !== undefined || spec.to !== undefined
    || spec.min !== undefined || spec.max !== undefined;
}

/** Previous / Page X of Y / Next — used by both the report preview and history. */
function Pager({
  page, totalPages, onPrev, onNext, disabled = false,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={onPrev}
        disabled={disabled || page <= 1}
        aria-label="Previous page"
      >
        <ChevronLeft className="mr-1 h-4 w-4" />
        Previous
      </Button>
      <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
        Page {page} of {totalPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onNext}
        disabled={disabled || page >= totalPages}
        aria-label="Next page"
      >
        Next
        <ChevronRight className="ml-1 h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * Excel-style per-column header control: sort asc/desc + a kind-appropriate
 * filter (contains / date range / min-max), plus "Clear this filter". Column
 * kind comes from `classifyPreviewColumnKind` -- generic, never hardcoded to
 * a specific custom-field name.
 */
function ColumnHeaderMenu({
  column, sortColumn, sortDirection, filter, disabled, onSort, onApplyFilter,
}: {
  column: string;
  sortColumn: string | null;
  sortDirection: SortDirection;
  filter: ColumnFilterSpec | undefined;
  disabled: boolean;
  onSort: (column: string, direction: SortDirection) => void;
  onApplyFilter: (column: string, spec: ColumnFilterSpec | null) => void;
}) {
  const kind = classifyPreviewColumnKind(column);
  const active = isFilterActive(filter);
  const isSorted = sortColumn === column;
  const [open, setOpen] = useState(false);
  const [contains, setContains] = useState(filter?.contains ?? "");
  const [from, setFrom] = useState(filter?.from ?? "");
  const [to, setTo] = useState(filter?.to ?? "");
  const [min, setMin] = useState(filter?.min !== undefined ? String(filter.min) : "");
  const [max, setMax] = useState(filter?.max !== undefined ? String(filter.max) : "");

  const handleOpenChange = (next: boolean) => {
    if (next) {
      // Reflect whatever is actually applied right now, in case it changed
      // elsewhere (e.g. "Reset view" or clearing a different column's filter).
      setContains(filter?.contains ?? "");
      setFrom(filter?.from ?? "");
      setTo(filter?.to ?? "");
      setMin(filter?.min !== undefined ? String(filter.min) : "");
      setMax(filter?.max !== undefined ? String(filter.max) : "");
    }
    setOpen(next);
  };

  const apply = () => {
    let spec: ColumnFilterSpec | null = null;
    if (kind === "text") {
      const v = contains.trim();
      if (v) spec = { contains: v };
    } else if (kind === "date") {
      const f = from.trim();
      const t = to.trim();
      if (f || t) spec = { ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) };
    } else {
      const mn = min.trim();
      const mx = max.trim();
      const parsedMin = mn ? Number(mn) : undefined;
      const parsedMax = mx ? Number(mx) : undefined;
      if (parsedMin !== undefined || parsedMax !== undefined) {
        spec = { ...(parsedMin !== undefined ? { min: parsedMin } : {}), ...(parsedMax !== undefined ? { max: parsedMax } : {}) };
      }
    }
    onApplyFilter(column, spec);
    setOpen(false);
  };

  const clear = () => {
    setContains("");
    setFrom("");
    setTo("");
    setMin("");
    setMax("");
    onApplyFilter(column, null);
    setOpen(false);
  };

  const sortedLabel = isSorted ? (sortDirection === "asc" ? "sorted ascending" : "sorted descending") : "";
  const stateLabel = [sortedLabel, active ? "filtered" : ""].filter(Boolean).join(", ");

  return (
    <div className="flex items-center gap-1">
      <span className="truncate">{column}</span>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Sort or filter ${column}`}
            title={stateLabel ? `${column}: ${stateLabel}` : `Sort or filter ${column}`}
            className={`relative inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
              isSorted || active ? "border-primary/50 bg-primary/10 text-primary" : "border-transparent"
            }`}
          >
            {isSorted && (sortDirection === "asc"
              ? <ArrowUp className="h-3.5 w-3.5" aria-hidden />
              : <ArrowDown className="h-3.5 w-3.5" aria-hidden />)}
            <Filter className={`h-3.5 w-3.5 ${active ? "fill-current" : ""}`} aria-hidden />
            {active && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />}
            {stateLabel && <span className="sr-only">{stateLabel}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-72 max-w-[calc(100vw-1.5rem)] space-y-3 border border-border bg-popover text-popover-foreground shadow-lg"
          align="start"
          collisionPadding={12}
        >
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sort</p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={isSorted && sortDirection === "asc" ? "default" : "outline"}
                size="sm"
                disabled={disabled}
                aria-pressed={isSorted && sortDirection === "asc"}
                onClick={() => { onSort(column, "asc"); setOpen(false); }}
              >
                <ArrowUp className="mr-1 h-3.5 w-3.5" />
                Asc
              </Button>
              <Button
                type="button"
                variant={isSorted && sortDirection === "desc" ? "default" : "outline"}
                size="sm"
                disabled={disabled}
                aria-pressed={isSorted && sortDirection === "desc"}
                onClick={() => { onSort(column, "desc"); setOpen(false); }}
              >
                <ArrowDown className="mr-1 h-3.5 w-3.5" />
                Desc
              </Button>
            </div>
          </div>

          <div className="space-y-1.5 border-t border-border pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</p>
            {kind === "text" && (
              <Input
                value={contains}
                onChange={(e) => setContains(e.target.value)}
                placeholder="Contains…"
                aria-label={`${column} contains`}
                className="h-9 text-sm"
                onKeyDown={(e) => e.key === "Enter" && apply()}
              />
            )}
            {kind === "date" && (
              <div className="space-y-2">
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span>From</span>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-full text-sm" aria-label="From date" />
                </label>
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span>To</span>
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-full text-sm" aria-label="To date" />
                </label>
              </div>
            )}
            {kind === "money" && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span>Min</span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={min}
                    onChange={(e) => setMin(e.target.value)}
                    placeholder="Min"
                    className="h-9 w-full text-sm"
                    onKeyDown={(e) => e.key === "Enter" && apply()}
                  />
                </label>
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span>Max</span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={max}
                    onChange={(e) => setMax(e.target.value)}
                    placeholder="Max"
                    className="h-9 w-full text-sm"
                    onKeyDown={(e) => e.key === "Enter" && apply()}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={clear} disabled={!active} className="disabled:opacity-60">
              <X className="mr-1 h-3.5 w-3.5" />
              Clear this filter
            </Button>
            <Button type="button" size="sm" onClick={apply} disabled={disabled}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Lifecycle badge for one Report History row. */
function HistoryStatusBadge({ entry }: { entry: ExportHistoryEntry }) {
  switch (entry.status) {
    case "queued":
      return <Badge variant="outline" className="shrink-0 text-[10px] font-normal">Queued</Badge>;
    case "running":
      return <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">Generating</Badge>;
    case "failed":
      return <Badge variant="destructive" className="shrink-0 text-[10px] font-normal">Failed</Badge>;
    case "cancelled":
      return <Badge variant="outline" className="shrink-0 text-[10px] font-normal">Cancelled</Badge>;
    default:
      return <Badge variant="success" className="shrink-0 text-[10px] font-normal">Completed</Badge>;
  }
}

interface ServerReportExportPanelProps {
  organizationId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  userId: string | null;
  userIds: string[] | null;
  teamScoped: boolean;
  disabled?: boolean;
  /** Omitted = the Daily Project Report. */
  reportType?: ExpenseReportType;
  /** Only meaningful for the expense-based reports. */
  category?: string | null;
  engineerStatus?: string | null;
  /** Detailed Expense only: stable custom-field label -> selected value, "all"-valued entries already excluded by the caller. */
  customFieldFilters?: Record<string, string>;
  /** Detailed Expense only: raw Year/Month/Week selector values, frozen into the job's own parameters for an honest history summary later (never re-derived from today's filter controls). */
  selectedYear?: string;
  selectedMonth?: string;
  selectedWeek?: string;
  /** Admin only: show Sync to Tally (never on team-scoped reports). Needs VITE_PWT_SYNC=1. */
  enableTallySync?: boolean;
  /** Claim Approval: HO status filter value passed to the sync. */
  hoStatus?: string | null;
  /** Claim reports: custom-field filters passed to the sync. */
  syncCustomFieldFilters?: Record<string, string>;
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
  customFieldFilters,
  selectedYear,
  selectedMonth,
  selectedWeek,
  enableTallySync = false,
  hoStatus,
  syncCustomFieldFilters,
}: ServerReportExportPanelProps) {
  const { toast } = useToast();
  const [job, setJob] = useState<ExportJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ExportHistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReportPreviewPageV2 | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Which job's preview (and Download target) is on screen right now --
  // distinct from `job`, which tracks the CURRENTLY GENERATING/latest job's
  // own lifecycle. Viewing an older history row must never overwrite `job`.
  const [activePreviewJobId, setActivePreviewJobId] = useState<string | null>(null);
  // Sticky copy of the actively-previewed job's own history metadata
  // (filename / timestamps / frozen parameters / storage_path for Download).
  // Deliberately NOT derived by looking `activePreviewJobId` up in `history`
  // on every render -- that lookup goes empty the moment the user pages
  // history away from that row, which would wrongly clear the header and the
  // Download button for a report that is still actively being viewed (§47).
  const [activePreviewEntry, setActivePreviewEntry] = useState<ExportHistoryEntry | null>(null);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilterSpec>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  // organization + report type this panel is currently showing. Async loads
  // started under an earlier context must never write into a later one (an
  // Org A report leaking onto Org B's screen after an org/account switch).
  const contextKeyRef = useRef<string>("");
  // Generation-token guard (same primitive as the My Expenses month fetch): a
  // response is applied only if it belongs to the newest preview request, so a
  // slow earlier request (page 2, an old filter, an auto-preview after
  // generation) can never overwrite a newer sort/filter/page result.
  const previewGuardRef = useRef(createMonthFetchGuardState());

  const effectiveType = reportType ?? "daily_project_report";
  // On-page preview is Detailed Expense only for now (DOC-131) — the other
  // three report types have no stored row set to page through.
  const previewSupported = effectiveType === "detailed_expense";

  // Every generated report leaves a row; this surfaces them so an
  // earlier file can be re-downloaded instead of regenerated. Paginated
  // (5 per page) rather than a flat top-20 list, with a real total count so
  // the pager can render "Page X of Y" instead of guessing.
  const loadHistory = useCallback(async (offset = historyOffset) => {
    if (!organizationId) return;
    const key = `${organizationId}:${effectiveType}`;
    setHistoryLoading(true);
    try {
      const page = await listReportExportJobsPaged(organizationId, effectiveType, offset, HISTORY_PAGE_SIZE);
      if (contextKeyRef.current !== key) return;
      setHistory(page.jobs);
      setHistoryTotal(page.totalCount);
      setHistoryOffset(page.offset);
    } catch (err) {
      // History is supplementary and must not block generating, but a silent
      // failure made a real problem look like "nothing was generated".
      console.warn("Report history could not be loaded:", err instanceof Error ? err.message : err);
    } finally {
      setHistoryLoading(false);
    }
  }, [organizationId, effectiveType, historyOffset]);

  const loadPreview = useCallback(async (
    jobId: string,
    page: number,
    sortCol: string | null,
    sortDir: SortDirection,
    filters: Record<string, ColumnFilterSpec>,
  ) => {
    if (!previewSupported) return;
    const key = contextKeyRef.current;
    setPreviewLoading(true);
    const outcome = await runMonthFetch(
      previewGuardRef.current,
      () => contextKeyRef.current === key,
      () => fetchReportExportJobPreviewPageV2(jobId, page, PREVIEW_PAGE_SIZE, sortCol, sortDir, filters),
    );
    // stale / aborted: a newer request (or a context change) owns the state now.
    if (outcome.kind === "stale" || outcome.kind === "aborted") return;
    if (outcome.kind === "success") {
      setPreview(outcome.data);
      setPreviewPage(outcome.data.page);
    } else {
      // The preview is a convenience on top of the download, which already
      // succeeded by the time this runs -- never surface this as a report
      // error, but leave a trace so "preview unavailable" is diagnosable.
      console.warn("Report preview could not be loaded:", outcome.error instanceof Error ? outcome.error.message : outcome.error);
      setPreview(null);
    }
    setPreviewLoading(false);
  }, [previewSupported]);

  /** View this history row's own frozen preview: switch target, reset page/sort/filters. */
  const viewHistoryEntry = useCallback((entry: ExportHistoryEntry) => {
    setActivePreviewJobId(entry.id);
    setActivePreviewEntry(entry);
    setSortColumn(null);
    setSortDirection("asc");
    setColumnFilters({});
    void loadPreview(entry.id, 1, null, "asc", {});
  }, [loadPreview]);

  const applySort = useCallback((column: string, direction: SortDirection) => {
    if (!activePreviewJobId) return;
    setSortColumn(column);
    setSortDirection(direction);
    void loadPreview(activePreviewJobId, 1, column, direction, columnFilters);
  }, [activePreviewJobId, columnFilters, loadPreview]);

  const applyFilter = useCallback((column: string, spec: ColumnFilterSpec | null) => {
    if (!activePreviewJobId) return;
    const next = { ...columnFilters };
    if (spec) next[column] = spec; else delete next[column];
    setColumnFilters(next);
    void loadPreview(activePreviewJobId, 1, sortColumn, sortDirection, next);
  }, [activePreviewJobId, columnFilters, sortColumn, sortDirection, loadPreview]);

  const resetView = useCallback(() => {
    if (!activePreviewJobId) return;
    setSortColumn(null);
    setSortDirection("asc");
    setColumnFilters({});
    void loadPreview(activePreviewJobId, 1, null, "asc", {});
  }, [activePreviewJobId, loadPreview]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Opportunistically refresh the sticky active-preview entry whenever its
  // row happens to be present in the currently loaded history page (fresher
  // row_count/expiry, or filling it in the first time after a fresh
  // generation's own history reload lands) -- but never CLEAR it just
  // because the current history page doesn't happen to contain it.
  useEffect(() => {
    if (!activePreviewJobId) {
      setActivePreviewEntry(null);
      return;
    }
    const match = history.find((h) => h.id === activePreviewJobId);
    if (match) setActivePreviewEntry(match);
  }, [history, activePreviewJobId]);

  const poll = useCallback(
    (jobId: string) => {
      stopPolling();
      startedAtRef.current = Date.now();
      const key = contextKeyRef.current;
      pollRef.current = setInterval(async () => {
        if (contextKeyRef.current !== key) {
          stopPolling();
          return;
        }
        if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
          stopPolling();
          setError("Still generating. Reopen this page shortly to collect the file.");
          return;
        }
        try {
          const next = await fetchExportJob(jobId);
          if (!next || contextKeyRef.current !== key) return;
          setJob(next);
          if (isTerminalStatus(next.status)) {
            stopPolling();
            void loadHistory(0);
            if (next.status === "failed") {
              setError(next.error_message_safe || "The report could not be generated.");
            } else if (next.status === "cancelled") {
              setError("This report was cancelled.");
            } else if (next.status === "completed" && previewSupported) {
              // Generation complete: this brand-new report automatically
              // becomes the active-preview job (page 1, filters/sort reset)
              // — never leaves an older "Viewing" job stuck on screen next
              // to a report that just superseded it.
              setActivePreviewJobId(jobId);
              setSortColumn(null);
              setSortDirection("asc");
              setColumnFilters({});
              void loadPreview(jobId, 1, null, "asc", {});
            }
          }
        } catch (err) {
          // Transient -- the next tick retries -- but leave a trace.
          console.warn("Report status poll failed:", err instanceof Error ? err.message : err);
        }
      }, POLL_MS);
    },
    [stopPolling, loadHistory, loadPreview, previewSupported],
  );

  // On mount / organization or report-type change: drop EVERYTHING that
  // belonged to the previous context (an Org A report must never stay on
  // screen after switching to Org B), then restore the latest job whatever
  // state it is in -- a failed or still-running report must survive a page
  // reload instead of vanishing behind "No reports generated yet".
  useEffect(() => {
    const key = `${organizationId ?? ""}:${effectiveType}`;
    contextKeyRef.current = key;
    invalidateMonthFetch(previewGuardRef.current);
    setPreviewLoading(false);
    stopPolling();
    setJob(null);
    setError(null);
    setPreview(null);
    setActivePreviewJobId(null);
    setActivePreviewEntry(null);
    setSortColumn(null);
    setSortDirection("asc");
    setColumnFilters({});
    setHistory([]);
    setHistoryTotal(0);
    setHistoryOffset(0);
    if (!organizationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const latest = await fetchLatestExportJob(organizationId, reportType ?? "daily_project_report");
        if (cancelled || contextKeyRef.current !== key) return;
        if (latest) {
          setJob(latest);
          if (latest.status === "completed") {
            if (previewSupported) {
              setActivePreviewJobId(latest.id);
              void loadPreview(latest.id, 1, null, "asc", {});
            }
          } else if (latest.status === "queued" || latest.status === "running") {
            poll(latest.id);
          } else if (latest.status === "failed") {
            setError(latest.error_message_safe || "The report could not be generated.");
          } else if (latest.status === "cancelled") {
            setError("This report was cancelled.");
          }
        }
        if (!cancelled) await loadHistory(0);
      } catch (err) {
        console.warn("Latest report could not be restored:", err instanceof Error ? err.message : err);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- context identity is organization + report type only; loaders are stable per that identity
  }, [organizationId, reportType]);

  const generate = async () => {
    if (!organizationId) return;
    setStarting(true);
    setError(null);
    setJob(null);
    // A brand-new report's preview must never look like it belongs to the
    // one just superseded — clear it rather than show stale rows while the
    // new job runs (§14). History also returns to page 1 so the just-started
    // generation's own row is where the user will look for it once done.
    invalidateMonthFetch(previewGuardRef.current);
    setPreviewLoading(false);
    setPreview(null);
    setActivePreviewJobId(null);
    setActivePreviewEntry(null);
    setSortColumn(null);
    setSortDirection("asc");
    setColumnFilters({});
    setHistoryOffset(0);
    try {
      const res = reportType
        ? await enqueueExpenseReportExport({
            organizationId, reportType, category, userId, userIds,
            engineerStatus, dateFrom, dateTo, teamScoped, customFieldFilters,
            selectedYear, selectedMonth, selectedWeek,
          })
        : await enqueueDailyProjectReportExport({
            organizationId, dateFrom, dateTo, userId, userIds, teamScoped, format: "csv",
          });
      // Nudge the worker for THIS job specifically, then poll regardless of
      // whether the nudge landed (the cron backstop still drains the queue).
      void triggerExportWorker(res.job_id);
      const initial = await fetchExportJob(res.job_id);
      if (initial) setJob(initial);
      poll(res.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the report.");
    } finally {
      setStarting(false);
    }
  };

  // Whichever job is actively previewed is what Download must reflect. Most
  // of the time that IS `job` (the current/latest generation) -- this only
  // reroutes Download when the user has actually clicked "View" on a
  // DIFFERENT, older job (§43-44). Report types with no preview at all
  // (previewSupported false) never set activePreviewJobId, so this always
  // falls through to the plain, original `ready ? job : null` behavior.
  const viewingDifferentJob = previewSupported && activePreviewEntry !== null && activePreviewEntry.id !== job?.id;
  const activeDownloadTarget: ExportJob | null = viewingDifferentJob
    ? {
        id: activePreviewEntry!.id,
        status: "completed",
        progress_current: 0,
        progress_total: null,
        filename: activePreviewEntry!.filename,
        storage_path: activePreviewEntry!.storage_path,
        file_size_bytes: activePreviewEntry!.file_size_bytes,
        error_message_safe: null,
        created_at: activePreviewEntry!.created_at,
        completed_at: activePreviewEntry!.completed_at,
      }
    : job?.status === "completed" && job.storage_path
      ? job
      : null;

  const download = async () => {
    if (!activeDownloadTarget) return;
    setDownloading(true);
    try {
      await downloadExportJobFile(activeDownloadTarget);
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

  const retryEntry = async (entry: ExportHistoryEntry) => {
    if (!organizationId) return;
    setHistoryBusy(entry.id);
    try {
      const res = await retryReportExportJob({
        organizationId,
        reportType: effectiveType,
        parameters: entry.parameters,
        teamScoped,
      });
      setError(null);
      setPreview(null);
      setActivePreviewJobId(null);
      setActivePreviewEntry(null);
      setSortColumn(null);
      setSortDirection("asc");
      setColumnFilters({});
      void triggerExportWorker(res.job_id);
      const initial = await fetchExportJob(res.job_id);
      if (initial) setJob(initial);
      poll(res.job_id);
      void loadHistory(0);
    } catch (err) {
      toast({
        title: "Could not retry",
        description: err instanceof Error ? err.message : "Could not restart that report.",
        variant: "destructive",
      });
    } finally {
      setHistoryBusy(null);
    }
  };

  const busy = starting || (job != null && !isTerminalStatus(job.status));
  const ready = job?.status === "completed" && job.storage_path;

  // Header metadata for the "Generated report" area must reflect the
  // ACTIVELY VIEWED job's own frozen info -- never today's live filter
  // controls, and never silently fall back to whatever `job` currently is
  // once an older report is being viewed (§45-46).
  const isViewingHistorical = viewingDifferentJob;
  const previewHeaderFilename = activePreviewEntry?.filename
    ?? (job && job.id === activePreviewJobId ? job.filename : null);
  const previewHeaderGeneratedAtIso = activePreviewEntry
    ? (activePreviewEntry.completed_at ?? activePreviewEntry.created_at)
    : (job && job.id === activePreviewJobId ? (job.completed_at ?? job.created_at) : null);
  const previewHeaderSummary = activePreviewEntry ? formatHistoryParameterSummary(activePreviewEntry) : null;
  const viewHasChanges = sortColumn !== null || Object.keys(columnFilters).length > 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Generate report</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        The report is built on the server. When it is ready, download it as a CSV.
      </p>

      {(() => {
        const actionRow = (syncButton: ReactNode) => (
      <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void generate()} disabled={disabled || busy || !organizationId}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {busy ? "Generating on server…" : "Generate report"}
          </Button>

          {syncButton}

          {activeDownloadTarget && (
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
        );
        return enableTallySync && PWT_SYNC_ENABLED && reportType === "detailed_expense" ? (
          <PwtSyncGroup
            organizationId={organizationId}
            disabled={disabled}
            params={{
            reportType: reportType ?? "daily_project",
            category,
            userId,
            userIds,
            engineerStatus,
            hoStatus,
            dateFrom,
            dateTo,
            customFieldFilters: syncCustomFieldFilters ?? customFieldFilters,
            selectedYear,
            selectedMonth,
            selectedWeek,
          }}
          >
            {({ button, status }) => (
              <>
                {actionRow(button)}
                {status}
              </>
            )}
          </PwtSyncGroup>
        ) : (
          actionRow(null)
        );
      })()}

      {busy && job && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {job.status === "queued"
            ? "Queued — waiting to start…"
            : job.progress_total
              ? `Generating… ${job.progress_current.toLocaleString()} of ${job.progress_total.toLocaleString()} rows`
              : "Generating…"}
        </p>
      )}

      {ready && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {job.filename}
          {` · ${(job.progress_total ?? job.progress_current ?? 0).toLocaleString()} rows`}
          {job.file_size_bytes ? ` · ${formatBytes(job.file_size_bytes)}` : ""}
        </p>
      )}
      {ready && (job.progress_total ?? job.progress_current ?? 0) === 0 && (
        <p className="text-sm text-muted-foreground">
          Completed with 0 rows — no rows matched these filters.
        </p>
      )}
      {ready && !previewSupported && (
        <p className="text-xs text-muted-foreground">
          This report type has no on-page preview; a successful run is shown by its row count and the Download button.
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* On-page preview of the ACTIVELY VIEWED report (the just-generated one
          by default, or an older one opened via "View" below) — the same
          rows the matching download contains, paginated so a 20,000+ row
          report never lands in the DOM at once. Detailed Expense only for
          now. Sort/filter here is a server-side VIEW over the frozen rows —
          it never touches the underlying CSV or recalculates Opening/Closing
          Balance. */}
      {previewSupported && activePreviewJobId && (
        <section aria-label="Generated report" className="rounded-lg border border-border bg-background p-3 shadow-sm space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <div className="flex items-center gap-2">
              <TableIcon className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">Generated report</h4>
            </div>
            <div className="flex items-center gap-2">
              {viewHasChanges && (
                <Button variant="ghost" size="sm" onClick={resetView} disabled={previewLoading}>
                  <RefreshCcw className="mr-1 h-3.5 w-3.5" />
                  Reset view
                </Button>
              )}
              {preview?.ready && previewHeaderGeneratedAtIso && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {preview.totalCount.toLocaleString()} rows · Generated {formatGeneratedAt(previewHeaderGeneratedAtIso)}
                </p>
              )}
            </div>
          </div>

          {(previewHeaderFilename || previewHeaderSummary) && (
            <div className="text-xs text-muted-foreground">
              {previewHeaderFilename && <p className="truncate">{previewHeaderFilename}</p>}
              {previewHeaderSummary && (
                <p className="truncate">
                  <span className="font-medium text-foreground/80">{previewHeaderSummary.employeeLine}</span>
                  {" · "}{previewHeaderSummary.rangeLine}
                  {previewHeaderSummary.chips.length > 0 && <> · {previewHeaderSummary.chips.join(" · ")}</>}
                </p>
              )}
            </div>
          )}

          {previewLoading && !preview && (
            <p className="text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
              Loading preview…
            </p>
          )}

          {preview && !preview.ready && (
            <p className="text-sm text-muted-foreground">
              {preview.reason === "no_preview_available"
                ? (isViewingHistorical
                    ? "Preview wasn't stored for this older report. Download the file to view it."
                    : "File generated, but the on-page preview is unavailable. Download the file to view it.")
                : "Preview isn't ready yet."}
            </p>
          )}

          {preview?.ready && preview.rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {viewHasChanges ? "No rows match the current view filters." : "No rows match these report filters."}
            </p>
          )}

          {preview?.ready && preview.rows.length > 0 && (
            <>
              <div className="relative">
              <div className="overflow-x-auto rounded-md border border-border" aria-busy={previewLoading}>
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-muted">
                    <tr>
                      {preview.columns.map((col) => (
                        <th
                          key={col}
                          scope="col"
                          className="whitespace-nowrap border-b border-r border-border bg-muted px-3 py-2 text-left font-semibold text-foreground last:border-r-0"
                        >
                          <ColumnHeaderMenu
                            column={col}
                            sortColumn={sortColumn}
                            sortDirection={sortDirection}
                            filter={columnFilters[col]}
                            disabled={previewLoading}
                            onSort={applySort}
                            onApplyFilter={applyFilter}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={i} className="odd:bg-background even:bg-muted/30 hover:bg-muted/60">
                        {preview.columns.map((col) => (
                          <td key={col} className="whitespace-nowrap border-b border-r border-border/60 px-3 py-2 tabular-nums last:border-r-0">
                            {row[col] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {previewLoading && (
                <div className="absolute inset-0 flex items-start justify-center rounded-md bg-background/60 pt-8" role="status" aria-live="polite">
                  <span className="inline-flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-1.5 text-sm shadow">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Updating preview…
                  </span>
                </div>
              )}
              </div>
              <p className="text-center text-xs text-muted-foreground tabular-nums">
                Showing {(preview.page - 1) * preview.pageSize + 1}
                –{Math.min(preview.page * preview.pageSize, preview.filteredTotalCount)} of {preview.filteredTotalCount.toLocaleString()}
                {viewHasChanges && preview.filteredTotalCount !== preview.totalCount && (
                  <> matching rows / {preview.totalCount.toLocaleString()} rows in generated report</>
                )}
              </p>
              {sortColumn && (
                <p className="text-center text-[11px] text-muted-foreground/70">
                  Sorting changes the display order only — each row's own Opening/Closing Balance stays attached to it.
                </p>
              )}
              <Pager
                page={preview.page}
                totalPages={Math.max(1, Math.ceil(preview.filteredTotalCount / preview.pageSize))}
                disabled={previewLoading}
                onPrev={() => activePreviewJobId && void loadPreview(activePreviewJobId, preview.page - 1, sortColumn, sortDirection, columnFilters)}
                onNext={() => activePreviewJobId && void loadPreview(activePreviewJobId, preview.page + 1, sortColumn, sortDirection, columnFilters)}
              />
            </>
          )}
        </section>
      )}

      {/* Generation history for THIS report type. */}
      <section aria-label="Report history" className="rounded-lg border border-border bg-background p-3 shadow-sm space-y-2">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Report history</h4>
        </div>

        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reports generated yet. Generated reports appear here and stay
            downloadable until they expire.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {history.map((h) => (
              <li
                key={h.id}
                className={`flex flex-wrap items-center justify-between gap-2 border-l-4 px-3 py-2 ${
                  h.id === activePreviewJobId ? "border-l-primary bg-primary/10" : "border-l-transparent bg-card hover:bg-muted/40"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">
                      {h.filename ?? "report.csv"}
                    </p>
                    {h.id === activePreviewJobId && (
                      <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">Viewing</Badge>
                    )}
                    <HistoryStatusBadge entry={h} />
                  </div>
                  {h.status === "failed" && (
                    <p className="mt-0.5 text-xs text-destructive">
                      {h.error_message_safe || "The report could not be generated."}
                    </p>
                  )}
                  {(h.status === "queued" || h.status === "running") && (
                    <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                      {h.status === "queued"
                        ? "Waiting to start"
                        : h.stale
                          ? "Generating… worker has not responded recently; it will be recovered automatically."
                          : h.progress_total
                            ? `Generating… ${(h.progress_current ?? 0).toLocaleString()} / ${h.progress_total.toLocaleString()}`
                            : "Generating…"}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {formatGeneratedAt(h.created_at)}
                    {" · "}
                    {h.requested_by_me ? "You" : h.requested_by_name}
                    {h.row_count ? ` · ${h.row_count.toLocaleString()} rows` : ""}
                    {h.file_size_bytes ? ` · ${formatBytes(h.file_size_bytes)}` : ""}
                  </p>
                  {(() => {
                    const summary = formatHistoryParameterSummary(h);
                    if (!summary) return null;
                    return (
                      <div className="mt-1 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground/80">{summary.employeeLine}</p>
                        <p>{summary.rangeLine}</p>
                        {summary.chips.length > 0 && (
                          <p className="truncate">{summary.chips.join(" · ")}</p>
                        )}
                      </div>
                    );
                  })()}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {(h.status === "failed" || h.status === "cancelled") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void retryEntry(h)}
                      disabled={historyBusy === h.id || busy}
                    >
                      <RotateCw className="mr-2 h-4 w-4" />
                      Retry
                    </Button>
                  )}
                  {previewSupported && h.status === "completed" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => viewHistoryEntry(h)}
                      disabled={h.id === activePreviewJobId || previewLoading}
                    >
                      <Eye className="mr-2 h-4 w-4" />
                      View
                    </Button>
                  )}
                  {h.status !== "completed" ? null : h.downloadable ? (
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
                </div>
              </li>
            ))}
          </ul>
        )}

        <Pager
          page={Math.floor(historyOffset / HISTORY_PAGE_SIZE) + 1}
          totalPages={Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE))}
          disabled={historyLoading}
          onPrev={() => void loadHistory(Math.max(0, historyOffset - HISTORY_PAGE_SIZE))}
          onNext={() => void loadHistory(historyOffset + HISTORY_PAGE_SIZE)}
        />
      </section>
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
