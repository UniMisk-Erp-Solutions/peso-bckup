import { useState, useEffect, useRef } from "react";

// Flow: Draft → Submitted → Under Review → Verified → Approved
const STATUS_WORKFLOW = [
  "Draft",
  "Submitted",
  "Under Review",
  "Verified",
  "Approved",
] as const;

type Status = (typeof STATUS_WORKFLOW)[number];

const STATUS_STYLES: Record<Status, { pill: string; dot: string }> = {
  Draft: { pill: "bg-slate-500 text-white", dot: "bg-white/90" },
  Submitted: { pill: "bg-primary text-primary-foreground", dot: "bg-primary-foreground/90" },
  "Under Review": { pill: "bg-amber-500 text-white", dot: "bg-white/90" },
  Verified: { pill: "bg-teal-600 text-white", dot: "bg-white/90" },
  Approved: { pill: "bg-emerald-600 text-white", dot: "bg-white/90" },
};

const TICK_MS = 50;
// Different cycle lengths so bars move out of sync (uneven / a bit chaotic)
const MONTHLY_CYCLE_MS = 4200;
const SPEND_CYCLE_MS = 3800;

export function DemoMotionPanel() {
  const [monthlyProgress, setMonthlyProgress] = useState(0);
  const [spendProgress, setSpendProgress] = useState(0);
  const [statusIndex, setStatusIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const monthlyStep = 100 / (MONTHLY_CYCLE_MS / TICK_MS);
    const spendStep = 100 / (SPEND_CYCLE_MS / TICK_MS);

    intervalRef.current = setInterval(() => {
      setMonthlyProgress((prev) => {
        const next = Math.min(100, prev + monthlyStep);
        return next >= 100 ? 0 : next;
      });
      setSpendProgress((prev) => {
        const next = Math.min(100, prev + spendStep);
        if (next >= 100) {
          setStatusIndex((i) => (i + 1) % STATUS_WORKFLOW.length);
          return 0;
        }
        return next;
      });
    }, TICK_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const status = STATUS_WORKFLOW[statusIndex];
  const { pill: statusPillClass, dot: statusDotClass } = STATUS_STYLES[status];

  return (
    <div className="rounded-xl border border-border bg-card/95 backdrop-blur-sm p-4 shadow-soft card-hover">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold text-foreground">Live Activity</h3>
        <span className="flex items-center gap-1 text-xs font-medium text-success">
          <span className="w-1.5 h-1.5 rounded-full bg-success" />
          Live
        </span>
      </div>
      <div className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground mb-2">Status:</p>
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusPillClass}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass}`} />
            {status}
          </span>
        </div>
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">Monthly Budget</span>
            <span className="text-muted-foreground tabular-nums">
              {Math.min(100, Math.round(monthlyProgress))}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-75 ease-linear"
              style={{ width: `${monthlyProgress}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">Spend used</span>
            <span className="text-muted-foreground tabular-nums">
              {Math.min(100, Math.round(spendProgress))}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-success transition-[width] duration-75 ease-linear"
              style={{ width: `${spendProgress}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
