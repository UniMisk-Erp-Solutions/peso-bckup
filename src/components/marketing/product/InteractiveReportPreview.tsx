import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Eye, Filter, RotateCcw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProductPreviewShell } from "./ProductPreviewShell";
import {
  DEMO_REPORTS,
  buildDemoCsv,
  formatDemoDate,
  formatDemoINR,
  type DemoReport,
  type DemoReportRow,
} from "./demoData";

export type ReportSortKey = "employee" | "date" | "txn" | "expenseType" | "projectName" | "debit" | "opening" | "closing";
export type ReportFilterKey = "employee" | "expenseType" | "projectName" | "month";
export interface ReportSort {
  key: ReportSortKey;
  dir: "asc" | "desc";
}
export type ReportFilters = Partial<Record<ReportFilterKey, string>>;

const MONTHS: Record<string, string> = { "2026-08": "August 2026", "2026-09": "September 2026" };

function valueFor(row: DemoReportRow, key: ReportSortKey): string | number {
  return row[key];
}

/** Pure demo logic (exported for tests): filter first, then sort; never mutates the input. */
export function applyReportView(rows: DemoReportRow[], filters: ReportFilters, sort: ReportSort | null): DemoReportRow[] {
  const filtered = rows.filter(
    (r) =>
      (!filters.employee || r.employee === filters.employee) &&
      (!filters.expenseType || r.expenseType === filters.expenseType) &&
      (!filters.projectName || r.projectName === filters.projectName) &&
      (!filters.month || r.date.startsWith(filters.month)),
  );
  if (!sort) return filtered;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...filtered].sort((a, b) => {
    const x = valueFor(a, sort.key);
    const y = valueFor(b, sort.key);
    const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true });
    return cmp * sign;
  });
}

interface Column {
  key: string;
  label: string;
  sortKey?: ReportSortKey;
  filterKey?: ReportFilterKey;
  numeric?: boolean;
  render: (r: DemoReportRow) => string;
}

const COLUMNS: Column[] = [
  { key: "employee", label: "Employee", sortKey: "employee", filterKey: "employee", render: (r) => r.employee },
  { key: "employeeId", label: "Employee ID", render: (r) => r.employeeId },
  { key: "date", label: "Date", sortKey: "date", filterKey: "month", render: (r) => formatDemoDate(r.date) },
  { key: "txn", label: "Transaction #", sortKey: "txn", render: (r) => r.txn },
  { key: "title", label: "Title", render: (r) => r.title },
  { key: "type", label: "Type", render: (r) => r.type },
  { key: "expenseType", label: "Expense Type", sortKey: "expenseType", filterKey: "expenseType", render: (r) => r.expenseType },
  { key: "projectId", label: "Project ID", render: (r) => r.projectId },
  { key: "projectName", label: "Project Name", sortKey: "projectName", filterKey: "projectName", render: (r) => r.projectName },
  { key: "debit", label: "Debit", sortKey: "debit", numeric: true, render: (r) => formatDemoINR(r.debit) },
  { key: "opening", label: "Opening Balance", sortKey: "opening", numeric: true, render: (r) => formatDemoINR(r.opening) },
  { key: "closing", label: "Closing Balance", sortKey: "closing", numeric: true, render: (r) => formatDemoINR(r.closing) },
];

function distinct(rows: DemoReportRow[], pick: (r: DemoReportRow) => string): string[] {
  return Array.from(new Set(rows.map(pick))).sort((a, b) => a.localeCompare(b));
}

function HeaderCell({
  col,
  rows,
  sort,
  filters,
  onSort,
  onFilter,
}: {
  col: Column;
  rows: DemoReportRow[];
  sort: ReportSort | null;
  filters: ReportFilters;
  onSort: (s: ReportSort | null) => void;
  onFilter: (k: ReportFilterKey, v: string) => void;
}) {
  const interactive = col.sortKey || col.filterKey;
  const [menuOpen, setMenuOpen] = useState(false);
  // Choosing a sort closes the menu (like the real report header); filters keep it open so the result is visible.
  const applySort = (s: ReportSort | null) => {
    onSort(s);
    setMenuOpen(false);
  };
  const sorted = sort && col.sortKey === sort.key ? sort.dir : null;
  const filtered = col.filterKey ? Boolean(filters[col.filterKey]) : false;

  let options: { value: string; label: string }[] = [];
  if (col.filterKey === "employee") options = distinct(rows, (r) => r.employee).map((v) => ({ value: v, label: v }));
  if (col.filterKey === "expenseType") options = distinct(rows, (r) => r.expenseType).map((v) => ({ value: v, label: v }));
  if (col.filterKey === "projectName") options = distinct(rows, (r) => r.projectName).map((v) => ({ value: v, label: v }));
  if (col.filterKey === "month") options = distinct(rows, (r) => r.date.slice(0, 7)).map((v) => ({ value: v, label: MONTHS[v] ?? v }));

  return (
    <th
      scope="col"
      aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "whitespace-nowrap border-b-2 border-r border-border bg-muted px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground last:border-r-0",
        col.numeric && "text-right",
      )}
    >
      {interactive ? (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`${col.label} column options${sorted ? `, sorted ${sorted === "asc" ? "ascending" : "descending"}` : ""}${filtered ? ", filtered" : ""}`}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                (sorted || filtered) && "text-primary",
              )}
            >
              {col.label}
              {sorted === "asc" ? (
                <ArrowUp className="h-3 w-3" aria-hidden />
              ) : sorted === "desc" ? (
                <ArrowDown className="h-3 w-3" aria-hidden />
              ) : (
                <ArrowUpDown className="h-3 w-3 opacity-60" aria-hidden />
              )}
              {col.filterKey ? <Filter className={cn("h-3 w-3", filtered ? "fill-primary" : "opacity-60")} aria-hidden /> : null}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 space-y-2 border-border p-3 shadow-lg">
            {col.sortKey ? (
              <div className="grid gap-1">
                <Button variant={sorted === "asc" ? "secondary" : "ghost"} size="sm" className="justify-start" onClick={() => applySort({ key: col.sortKey as ReportSortKey, dir: "asc" })}>
                  <ArrowUp className="mr-2 h-3.5 w-3.5" aria-hidden /> Sort ascending
                </Button>
                <Button variant={sorted === "desc" ? "secondary" : "ghost"} size="sm" className="justify-start" onClick={() => applySort({ key: col.sortKey as ReportSortKey, dir: "desc" })}>
                  <ArrowDown className="mr-2 h-3.5 w-3.5" aria-hidden /> Sort descending
                </Button>
              </div>
            ) : null}
            {col.filterKey ? (
              <div className="space-y-1.5 border-t border-border pt-2">
                <label className="text-[11px] font-medium text-muted-foreground" htmlFor={`demo-filter-${col.filterKey}`}>
                  Filter {col.label}
                </label>
                <select
                  id={`demo-filter-${col.filterKey}`}
                  aria-label={`Filter ${col.label}`}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={filters[col.filterKey] ?? ""}
                  onChange={(e) => onFilter(col.filterKey as ReportFilterKey, e.target.value)}
                >
                  <option value="">All</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {sorted ? (
              <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={() => applySort(null)}>
                Clear sort
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : (
        <span className="px-1">{col.label}</span>
      )}
    </th>
  );
}

function downloadCsv(filename: string, rows: DemoReportRow[]) {
  try {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(new Blob([buildDemoCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // a marketing demo must never throw for a failed download
  }
}

/**
 * Playable replica of the Detailed Expense report preview: spreadsheet-style
 * sort/filter on column headers, Reset view, and a report history where "View"
 * reopens another report's own snapshot. 3 small synthetic datasets, local state only.
 */
export function InteractiveReportPreview({ className }: { className?: string }) {
  const [activeId, setActiveId] = useState(DEMO_REPORTS[0].id);
  const [sort, setSort] = useState<ReportSort | null>(null);
  const [filters, setFilters] = useState<ReportFilters>({});
  // "Viewing" appears once the visitor reopens a report from history (as in the real product).
  const [viewing, setViewing] = useState(false);

  const report: DemoReport = DEMO_REPORTS.find((r) => r.id === activeId) ?? DEMO_REPORTS[0];
  const visible = useMemo(() => applyReportView(report.rows, filters, sort), [report, filters, sort]);
  const isCustomView = Boolean(sort) || Object.values(filters).some(Boolean);

  const view = (id: string) => {
    setActiveId(id);
    setViewing(true);
    setSort(null);
    setFilters({});
  };

  return (
    <ProductPreviewShell title="Reports" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            <span data-testid="demo-report-title">{report.title}</span>
            {viewing ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary" data-testid="demo-report-viewing-badge">
                <Eye className="h-3 w-3" aria-hidden /> Viewing
              </span>
            ) : null}
          </h3>
          <p className="text-xs text-muted-foreground" data-testid="demo-report-count" aria-live="polite">
            {visible.length} of {report.rows.length} rows
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setSort(null); setFilters({}); }} disabled={!isCustomView}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Reset view
        </Button>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-border" tabIndex={0} aria-label="Report preview table, scrolls horizontally">
        <table className="w-full min-w-[980px] border-collapse text-xs" data-testid="demo-report-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <HeaderCell
                  key={c.key}
                  col={c}
                  rows={report.rows}
                  sort={sort}
                  filters={filters}
                  onSort={setSort}
                  onFilter={(k, v) => setFilters((f) => ({ ...f, [k]: v || undefined }))}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-muted-foreground">
                  No rows match these filters.
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.txn} className="border-b border-border/70 last:border-b-0 hover:bg-muted/40">
                  {COLUMNS.map((c) => (
                    <td key={c.key} className={cn("whitespace-nowrap border-r border-border/50 px-3 py-2 text-foreground last:border-r-0", c.numeric && "text-right tabular-nums")}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-5">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Report history</h4>
        <ul className="space-y-2">
          {DEMO_REPORTS.map((r) => {
            const active = r.id === activeId;
            return (
              <li
                key={r.id}
                data-testid={`demo-history-${r.id}`}
                data-active={active}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between",
                  active ? "border-primary/50 bg-primary/5" : "border-border bg-background",
                )}
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">{r.filename}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {r.title.split(" · ")[0]} · {r.scope}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {active && viewing ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary" data-testid={`demo-history-viewing-${r.id}`}>
                      Viewing
                    </span>
                  ) : null}
                  <Button size="sm" variant={active ? "secondary" : "outline"} aria-label={`View ${r.filename}`} aria-pressed={active} onClick={() => view(r.id)}>
                    <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden /> View
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Download ${r.filename}`} onClick={() => downloadCsv(r.filename, r.rows)}>
                    <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Download
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[11px] text-muted-foreground">Sample reports with fictional data, shown for illustration.</p>
      </div>
    </ProductPreviewShell>
  );
}
