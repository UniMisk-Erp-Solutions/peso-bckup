/**
 * DOC-103 — "Saved reports" list.
 *
 * Every generation is written to the database (see generatedReportStore.ts), so
 * this is where a report goes after you click Generate. Before this existed a
 * report lived only in the browser tab that produced it and was lost on reload.
 *
 * The list is metadata only — payloads are fetched one at a time, on demand, so
 * opening this panel never pulls megabytes it might not need.
 */
import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { RefreshCw, FileClock, Download, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  listGeneratedReports,
  loadGeneratedReport,
  formatPayloadBytes,
  type GeneratedReportListItem,
  type GeneratedReportType,
} from "@/lib/generatedReportStore";

interface SavedReportsPanelProps {
  organizationId: string | null;
  reportType: GeneratedReportType;
  /** Called with a stored snapshot's rows when the user opens one. */
  onOpenSnapshot?: (rows: unknown, meta: GeneratedReportListItem) => void;
  /** Bumping this refetches the list (e.g. after a new report is saved). */
  refreshToken?: unknown;
}

function describeFilters(filters: Record<string, unknown>): string {
  const parts: string[] = [];
  const period = filters.period;
  if (period === "all_time") parts.push("All time");
  else if (filters.date_from || filters.date_to) {
    parts.push(`${filters.date_from ?? "…"} → ${filters.date_to ?? "…"}`);
  }
  const employee = filters.employee;
  parts.push(!employee || employee === "all" ? "All employees" : "1 employee");
  if (filters.team_scoped === true) parts.push("Team-scoped");
  return parts.join(" · ");
}

export function SavedReportsPanel({
  organizationId,
  reportType,
  onOpenSnapshot,
  refreshToken,
}: SavedReportsPanelProps) {
  const [items, setItems] = useState<GeneratedReportListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await listGeneratedReports(organizationId, reportType));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load saved reports.");
    } finally {
      setLoading(false);
    }
  }, [organizationId, reportType]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const openSnapshot = async (item: GeneratedReportListItem) => {
    if (!onOpenSnapshot) return;
    setOpeningId(item.id);
    try {
      const full = await loadGeneratedReport(item.id);
      onOpenSnapshot(full.payload, item);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that report.");
    } finally {
      setOpeningId(null);
    }
  };

  if (!organizationId) return null;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <FileClock className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Saved reports</h3>
          {items.length > 0 && (
            <Badge variant="secondary" className="text-xs">{items.length}</Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh saved reports"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {items.length === 0 && !loading && !error ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No saved reports yet. Every report you generate is stored here automatically.
        </p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {format(new Date(item.last_generated_at), "dd MMM yyyy, HH:mm")}
                  <span className="ml-2 font-normal text-muted-foreground">
                    by {item.generated_by_name}
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {describeFilters(item.filters)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {item.row_count.toLocaleString()} rows · {formatPayloadBytes(item.payload_bytes)}
                  {item.generation_count > 1 && ` · regenerated ${item.generation_count}×`}
                  {" · expires "}
                  {format(new Date(item.expires_at), "dd MMM yyyy")}
                </p>
              </div>
              {onOpenSnapshot && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openSnapshot(item)}
                  disabled={openingId === item.id}
                  className="shrink-0"
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {openingId === item.id ? "Opening…" : "Open"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
