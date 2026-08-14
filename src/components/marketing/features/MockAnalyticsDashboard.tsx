import { ArrowUp, ArrowDown, TrendingUp } from "lucide-react";

const barHeights = [65, 45, 80, 55, 90, 70, 85];
const days = ["M", "T", "W", "T", "F", "S", "S"];

export function MockAnalyticsDashboard() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-soft">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">
        Analytics Dashboard
      </p>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="p-2.5 rounded-lg bg-muted/30 border border-border">
          <p className="text-[10px] text-muted-foreground mb-1">Total Expenses</p>
          <p className="text-sm font-bold text-foreground">₹ 125,450</p>
          <p className="text-[10px] text-accent flex items-center gap-0.5">
            <ArrowUp className="h-3 w-3" /> +12%
          </p>
        </div>
        <div className="p-2.5 rounded-lg bg-muted/30 border border-border">
          <p className="text-[10px] text-muted-foreground mb-1">Approved</p>
          <p className="text-sm font-bold text-foreground">87</p>
          <p className="text-[10px] text-accent flex items-center gap-0.5">
            <ArrowUp className="h-3 w-3" /> +5
          </p>
        </div>
        <div className="p-2.5 rounded-lg bg-muted/30 border border-border">
          <p className="text-[10px] text-muted-foreground mb-1">Pending</p>
          <p className="text-sm font-bold text-foreground">12</p>
          <p className="text-[10px] text-warning flex items-center gap-0.5">
            <ArrowDown className="h-3 w-3" /> -3
          </p>
        </div>
      </div>
      <div className="p-3 rounded-lg bg-muted/30 border border-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-muted-foreground">Weekly Trend</span>
          <TrendingUp className="h-3 w-3 text-accent" />
        </div>
        <div className="flex items-end justify-between gap-1 h-12">
          {barHeights.map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm bg-primary/60 hover:bg-primary transition-colors"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        <div className="flex justify-between gap-1 mt-1">
          {days.map((d, i) => (
            <span key={i} className="text-[8px] text-muted-foreground flex-1 text-center">
              {d}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
