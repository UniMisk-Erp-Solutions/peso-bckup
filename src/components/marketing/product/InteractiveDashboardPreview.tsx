import { useState } from "react";
import { Wallet, Coins, Clock, Receipt } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ProductPreviewShell } from "./ProductPreviewShell";
import { DASHBOARD_PERIODS, formatDemoINR, type DashboardPeriodId } from "./demoData";

/**
 * A playable replica of the PesoWise Dashboard: switching the month updates
 * every card together. Local state only -- no data source of any kind.
 */
export function InteractiveDashboardPreview({ className }: { className?: string }) {
  const [periodId, setPeriodId] = useState<DashboardPeriodId>("all");
  const period = DASHBOARD_PERIODS.find((p) => p.id === periodId) ?? DASHBOARD_PERIODS[0];

  const cards = [
    { id: "balance", title: "Current Balance", value: formatDemoINR(period.balance), sub: period.balanceLabel, icon: Wallet, tone: "success" as const },
    { id: "expenses", title: "Total Expenses", value: formatDemoINR(period.totalExpenses), sub: periodId === "all" ? "Total amount, all expenses" : `Expense amount · ${period.label}`, icon: Coins, tone: "neutral" as const },
    { id: "pending", title: "Pending Amount", value: formatDemoINR(period.pending), sub: period.pendingLabel, icon: Clock, tone: "neutral" as const },
  ];

  return (
    <ProductPreviewShell title="Dashboard" className={className}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-lg font-bold tracking-tight text-foreground">Dashboard</h3>
          <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="demo-dashboard-scope">
            {periodId === "all" ? "Showing all time" : `Showing ${period.label}`}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Label htmlFor="demo-dashboard-month" className="whitespace-nowrap text-xs text-muted-foreground">
            Month:
          </Label>
          <Select value={periodId} onValueChange={(v) => setPeriodId(v as DashboardPeriodId)}>
            <SelectTrigger id="demo-dashboard-month" aria-label="Dashboard month" className="h-9 w-full sm:w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DASHBOARD_PERIODS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.id}
              data-testid={`demo-card-${c.id}`}
              className={cn(
                "rounded-xl border p-3.5 transition-colors",
                c.tone === "success" ? "border-success/30 bg-success/5" : "border-border bg-muted/30",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-medium text-muted-foreground">{c.title}</p>
                <Icon className={cn("h-4 w-4 shrink-0", c.tone === "success" ? "text-success" : "text-muted-foreground")} aria-hidden />
              </div>
              <p
                key={`${c.id}-${periodId}`}
                className="mt-1.5 truncate text-xl font-bold tabular-nums text-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
                data-testid={`demo-value-${c.id}`}
              >
                {c.value}
              </p>
              <p className="mt-1 truncate text-[11px] text-muted-foreground" title={c.sub} data-testid={`demo-sub-${c.id}`}>
                {c.sub}
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1.4fr]">
        <div className="rounded-xl border border-border bg-muted/20 p-3.5">
          <p className="text-xs font-medium text-muted-foreground">Spend trend</p>
          <div className="mt-3 flex h-20 items-end gap-1.5" aria-hidden>
            {period.bars.map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-t bg-primary/70 motion-safe:transition-all motion-safe:duration-500"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Recent activity</p>
          <ul className="space-y-1.5">
            {period.activity.map((a) => (
              <li key={a.title} className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-2.5 py-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Receipt className="h-3.5 w-3.5 text-warning" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{a.title}</span>
                  <span className="block text-[11px] text-muted-foreground">{a.date}</span>
                </span>
                <span className="text-xs font-semibold tabular-nums text-foreground">{formatDemoINR(a.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ProductPreviewShell>
  );
}
