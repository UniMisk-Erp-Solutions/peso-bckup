import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

interface ReportQuery {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  data: unknown;
  dataUpdatedAt: number;
  refetch: () => void;
}

interface ReportLiveRefreshBarProps {
  query: ReportQuery;
}

function formatTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Slim non-blocking bar that communicates live-expense fetch state.
 *
 * States:
 * 1. Initial loading (isLoading=true, no data) — full progress bar + loading text
 * 2. Background refresh (isFetching, data exists) — slim bar + "Fetching live expenses…"
 * 3. Success — briefly shows "Report updated", then "Last updated HH:MM"
 * 4. Error with cached data — amber warning + Retry
 */
export function ReportLiveRefreshBar({ query }: ReportLiveRefreshBarProps) {
  const { t } = useTranslation("reports");
  const [pseudo, setPseudo] = useState(0);
  const [showUpdated, setShowUpdated] = useState(false);

  // Pseudo-progress: animate from 0→85 while fetching, never shows a real number
  useEffect(() => {
    if (!query.isFetching) {
      setPseudo(0);
      return;
    }
    setPseudo(10);
    const id = setInterval(() => {
      setPseudo((p) => {
        if (p >= 85) return 85;
        return p + (85 - p) * 0.08;
      });
    }, 200);
    return () => clearInterval(id);
  }, [query.isFetching]);

  // "Report updated" flash
  useEffect(() => {
    if (!query.isSuccess || query.isFetching) return;
    setShowUpdated(true);
    const id = setTimeout(() => setShowUpdated(false), 2500);
    return () => clearTimeout(id);
  }, [query.dataUpdatedAt, query.isSuccess, query.isFetching]);

  const hasData = query.data !== undefined;

  // Nothing to show when idle and data is fresh
  if (!query.isFetching && !query.isError && !showUpdated) return null;

  // ── Initial loading (no prior data) ──────────────────────────────────────
  if (query.isLoading && !hasData) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t("liveRefresh.initialLoading")}
        className="w-full space-y-2 py-2"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
          <span className="font-medium text-foreground">
            {t("liveRefresh.initialLoading")}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("liveRefresh.initialLoadingHint")}
        </p>
        <Progress
          value={pseudo}
          className="h-1.5 motion-reduce:transition-none"
          aria-hidden
        />
      </div>
    );
  }

  // ── Error with cached data ────────────────────────────────────────────────
  if (query.isError && hasData && !query.isFetching) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-amber-900 dark:text-amber-200">
            {t("liveRefresh.refreshFailed")}
          </span>{" "}
          <span className="text-amber-800 dark:text-amber-300">
            {t("liveRefresh.showingCached")}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 border-amber-400 text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900"
          onClick={() => query.refetch()}
        >
          {t("liveRefresh.retry")}
        </Button>
      </div>
    );
  }

  // ── Success flash ─────────────────────────────────────────────────────────
  if (showUpdated && !query.isFetching) {
    const updatedTime = query.dataUpdatedAt
      ? t("liveRefresh.lastUpdated", { time: formatTime(query.dataUpdatedAt) })
      : "";
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-xs text-muted-foreground py-1"
      >
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" aria-hidden />
        <span className="font-medium text-green-700 dark:text-green-400">
          {t("liveRefresh.updated")}
        </span>
        {updatedTime && <span>· {updatedTime}</span>}
      </div>
    );
  }

  // ── Background refresh (has data) ─────────────────────────────────────────
  if (query.isFetching && hasData) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t("liveRefresh.refreshing")}
        className="w-full space-y-1.5 py-1"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
          <span className="font-medium">{t("liveRefresh.refreshing")}</span>
          <span className="hidden sm:inline">·</span>
          <span className="hidden sm:inline">{t("liveRefresh.refreshingHint")}</span>
        </div>
        <Progress
          value={pseudo}
          className="h-0.5 motion-reduce:transition-none"
          aria-hidden
        />
      </div>
    );
  }

  return null;
}
