/**
 * MaintenanceHistoryTab — owner/admin-only maintenance occurrence history:
 * summary cards, a monthly downtime chart, filters, a responsive list, and
 * a detail drawer. Only ever rendered when the signed-in admin has
 * is_active=true AND can_view_history=true (enforced in
 * MaintenanceAdminDashboard.tsx) — database RLS remains authoritative
 * regardless (infra/maintenance-cloud/migrations/002_add_maintenance_history.sql).
 */
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  readMaintenanceHistory,
  MAINTENANCE_HISTORY_PAGE_SIZE,
} from "@/integrations/maintenance-cloud/maintenanceHistoryService";
import type {
  MaintenanceHistoryRow,
  MaintenanceHistoryKind,
} from "@/integrations/maintenance-cloud/types";
import { MAINTENANCE_ENV } from "@/maintenance/maintenanceConfig";
import { isValidMaintenanceEnvironment } from "@/maintenance/maintenanceResolver";
import {
  deriveMaintenanceHistoryStatus,
  maintenanceHistoryDurationMs,
  type MaintenanceHistoryDerivedStatus,
} from "@/maintenance/maintenanceHistoryDerivedStatus";
import {
  summarizeMaintenanceHistory,
  bucketMaintenanceHistoryByMonth,
} from "@/maintenance/maintenanceHistorySummary";
import { formatMaintenanceDateTime, formatMaintenanceCountdown } from "@/lib/maintenanceDateTime";

const STATUS_BADGE: Record<MaintenanceHistoryDerivedStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  upcoming: { label: "Upcoming", variant: "secondary" },
  active: { label: "Active", variant: "default" },
  completed: { label: "Completed", variant: "outline" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

function durationLabel(row: MaintenanceHistoryRow, now: Date): string {
  const ms = maintenanceHistoryDurationMs(row, now);
  if (ms === null) return "—";
  return formatMaintenanceCountdown(ms);
}

function actorLabel(actorId: string | null, ownUserId: string): string {
  if (!actorId) return "—";
  return actorId === ownUserId ? "You" : "Maintenance admin";
}

type Filters = {
  kind: MaintenanceHistoryKind | "all";
  status: MaintenanceHistoryDerivedStatus | "all";
  dateFrom: string;
  dateTo: string;
};

const EMPTY_FILTERS: Filters = { kind: "all", status: "all", dateFrom: "", dateTo: "" };

type Props = {
  ownUserId: string;
};

export function MaintenanceHistoryTab({ ownUserId }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<MaintenanceHistoryRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);

  // A bounded, separate fetch (up to 200 rows) purely for summary cards and
  // the chart — the table itself stays paginated at 20/page (§18/§24).
  const [statsRows, setStatsRows] = useState<MaintenanceHistoryRow[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [detailRow, setDetailRow] = useState<MaintenanceHistoryRow | null>(null);

  // A small operational table (§17 — history stays tiny) — recomputing on
  // every render is cheap, so `now` is a plain value, not memoized.
  const now = new Date();

  const loadPage = useCallback(async () => {
    if (!isValidMaintenanceEnvironment(MAINTENANCE_ENV)) return;
    setLoading(true);
    const result = await readMaintenanceHistory({
      environment: MAINTENANCE_ENV,
      page,
      kind: filters.kind === "all" ? undefined : filters.kind,
      dateFrom: filters.dateFrom ? new Date(filters.dateFrom).toISOString() : undefined,
      dateTo: filters.dateTo ? new Date(filters.dateTo).toISOString() : undefined,
    });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setTotalCount(result.totalCount);
    // Client-side status filter: status is derived, not stored, so it is
    // applied after the page is fetched (see maintenanceHistoryService.ts's
    // documented trade-off — a filtered page may show fewer than pageSize
    // rows; acceptable for a V1 operational table of this size).
    setRows(
      filters.status === "all"
        ? result.rows
        : result.rows.filter((r) => deriveMaintenanceHistoryStatus(r) === filters.status),
    );
  }, [page, filters]);

  const loadStats = useCallback(async () => {
    if (!isValidMaintenanceEnvironment(MAINTENANCE_ENV)) return;
    setStatsLoading(true);
    const result = await readMaintenanceHistory({ environment: MAINTENANCE_ENV, page: 1, pageSize: 200 });
    setStatsLoading(false);
    if (result.ok) setStatsRows(result.rows);
  }, []);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const summary = summarizeMaintenanceHistory(statsRows, now);
  const monthlyBuckets = bucketMaintenanceHistoryByMonth(statsRows, now, 6);

  const totalPages = Math.max(1, Math.ceil(totalCount / MAINTENANCE_HISTORY_PAGE_SIZE));

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Total maintenances</p>
          <div className="text-lg font-semibold text-foreground">
            {statsLoading ? <Skeleton className="h-6 w-10" /> : summary.totalOccurrences}
          </div>
        </div>
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Total maintenance time</p>
          <div className="text-lg font-semibold text-foreground">
            {statsLoading ? <Skeleton className="h-6 w-16" /> : formatMaintenanceCountdown(summary.totalDowntimeMs)}
          </div>
        </div>
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Average duration</p>
          <div className="text-lg font-semibold text-foreground">
            {statsLoading ? (
              <Skeleton className="h-6 w-16" />
            ) : summary.averageDurationMs !== null ? (
              formatMaintenanceCountdown(summary.averageDurationMs)
            ) : (
              "—"
            )}
          </div>
        </div>
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Last maintenance</p>
          <div className="text-sm font-semibold text-foreground">
            {statsLoading ? (
              <Skeleton className="h-6 w-24" />
            ) : summary.lastOccurrence ? (
              formatMaintenanceDateTime(
                summary.lastOccurrence.actual_started_at ?? summary.lastOccurrence.scheduled_start_at,
              )
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>
      {!statsLoading && summary.totalOccurrences > 0 && (
        <p className="text-xs text-muted-foreground">
          {summary.scheduledCount} scheduled · {summary.forcedCount} forced
        </p>
      )}

      {/* Chart */}
      <div className="rounded-lg border p-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Maintenance minutes by month
        </p>
        {statsLoading ? (
          <Skeleton className="h-[180px] w-full" />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart
              data={monthlyBuckets.map((b) => ({
                label: b.label,
                Scheduled: Math.round(b.scheduledMs / 60_000),
                Forced: Math.round(b.forcedMs / 60_000),
              }))}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
              <Tooltip formatter={(value: number) => `${value} min`} />
              <Bar dataKey="Scheduled" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} />
              <Bar dataKey="Forced" stackId="a" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="history-filter-kind">
            Type
          </label>
          <Select
            value={filters.kind}
            onValueChange={(v) => {
              setFilters((f) => ({ ...f, kind: v as Filters["kind"] }));
              setPage(1);
            }}
          >
            <SelectTrigger id="history-filter-kind" className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="forced">Forced</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="history-filter-status">
            Status
          </label>
          <Select
            value={filters.status}
            onValueChange={(v) => {
              setFilters((f) => ({ ...f, status: v as Filters["status"] }));
              setPage(1);
            }}
          >
            <SelectTrigger id="history-filter-status" className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="upcoming">Upcoming</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="history-filter-from">
            From
          </label>
          <input
            id="history-filter-from"
            type="date"
            value={filters.dateFrom}
            onChange={(e) => {
              setFilters((f) => ({ ...f, dateFrom: e.target.value }));
              setPage(1);
            }}
            className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="history-filter-to">
            To
          </label>
          <input
            id="history-filter-to"
            type="date"
            value={filters.dateTo}
            onChange={(e) => {
              setFilters((f) => ({ ...f, dateTo: e.target.value }));
              setPage(1);
            }}
            className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load history: {error}
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>End</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Changed by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No maintenance history yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const status = deriveMaintenanceHistoryStatus(r, now);
                const badge = STATUS_BADGE[status];
                const startAt = r.kind === "scheduled" ? r.scheduled_start_at : r.actual_started_at;
                const endAt = r.kind === "scheduled" ? r.scheduled_end_at : r.actual_ended_at;
                return (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setDetailRow(r)}
                  >
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="capitalize">{r.kind === "forced" ? "Immediate" : "Scheduled"}</TableCell>
                    <TableCell>{formatMaintenanceDateTime(r.created_at)}</TableCell>
                    <TableCell>{startAt ? formatMaintenanceDateTime(startAt) : "—"}</TableCell>
                    <TableCell>{endAt ? formatMaintenanceDateTime(endAt) : "—"}</TableCell>
                    <TableCell>{durationLabel(r, now)}</TableCell>
                    <TableCell className="max-w-[160px] truncate">{r.title || "—"}</TableCell>
                    <TableCell>{actorLabel(r.updated_by, ownUserId)}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-center text-muted-foreground py-8 text-sm">No maintenance history yet.</p>
        ) : (
          rows.map((r) => {
            const status = deriveMaintenanceHistoryStatus(r, now);
            const badge = STATUS_BADGE[status];
            const startAt = r.kind === "scheduled" ? r.scheduled_start_at : r.actual_started_at;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setDetailRow(r)}
                className="w-full text-left rounded-lg border p-3 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                  <span className="text-xs text-muted-foreground capitalize">
                    {r.kind === "forced" ? "Immediate" : "Scheduled"}
                  </span>
                </div>
                <p className="text-sm font-medium text-foreground">{r.title || "(no title)"}</p>
                <p className="text-xs text-muted-foreground">
                  {startAt ? formatMaintenanceDateTime(startAt) : "—"} · {durationLabel(r, now)}
                </p>
              </button>
            );
          })
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Page {page} of {totalPages} ({totalCount} total)
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      {/* Detail drawer */}
      <Sheet open={detailRow !== null} onOpenChange={(open) => !open && setDetailRow(null)}>
        <SheetContent>
          {detailRow && (
            <>
              <SheetHeader>
                <SheetTitle>{detailRow.title || "(no title)"}</SheetTitle>
                <SheetDescription>Maintenance occurrence details</SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-3 text-sm">
                <DetailRow label="Status" value={STATUS_BADGE[deriveMaintenanceHistoryStatus(detailRow, now)].label} />
                <DetailRow label="Environment" value={detailRow.environment} />
                <DetailRow label="Type" value={detailRow.kind === "forced" ? "Immediate" : "Scheduled"} />
                <DetailRow label="Message" value={detailRow.message || "—"} />
                <DetailRow label="Created" value={formatMaintenanceDateTime(detailRow.created_at, { withTimezone: true })} />
                {detailRow.kind === "scheduled" && (
                  <>
                    <DetailRow
                      label="Scheduled start"
                      value={detailRow.scheduled_start_at ? formatMaintenanceDateTime(detailRow.scheduled_start_at, { withTimezone: true }) : "—"}
                    />
                    <DetailRow
                      label="Scheduled end"
                      value={detailRow.scheduled_end_at ? formatMaintenanceDateTime(detailRow.scheduled_end_at, { withTimezone: true }) : "—"}
                    />
                  </>
                )}
                {detailRow.kind === "forced" && (
                  <>
                    <DetailRow
                      label="Actual start"
                      value={detailRow.actual_started_at ? formatMaintenanceDateTime(detailRow.actual_started_at, { withTimezone: true }) : "—"}
                    />
                    <DetailRow
                      label="Actual end"
                      value={detailRow.actual_ended_at ? formatMaintenanceDateTime(detailRow.actual_ended_at, { withTimezone: true }) : "still active"}
                    />
                  </>
                )}
                <DetailRow label="Duration" value={durationLabel(detailRow, now)} />
                {detailRow.cancelled_at && (
                  <DetailRow label="Cancelled" value={formatMaintenanceDateTime(detailRow.cancelled_at, { withTimezone: true })} />
                )}
                <DetailRow
                  label="Last modified"
                  value={formatMaintenanceDateTime(detailRow.updated_at, { withTimezone: true })}
                />
                <DetailRow label="Actor" value={actorLabel(detailRow.updated_by, ownUserId)} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b pb-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground text-right">{value}</span>
    </div>
  );
}
