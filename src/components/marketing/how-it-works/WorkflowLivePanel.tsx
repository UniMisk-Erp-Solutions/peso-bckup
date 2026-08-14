import { useState, useEffect, useRef } from "react";

const STATUS_CYCLE_MS = 2000;
const STATUSES = ["Draft", "Submitted", "Under Review", "Approved"] as const;
const STATUS_STYLES: Record<(typeof STATUSES)[number], string> = {
  Draft: "bg-muted text-muted-foreground",
  Submitted: "bg-primary text-primary-foreground",
  "Under Review": "bg-warning text-warning-foreground",
  Approved: "bg-accent text-accent-foreground",
};

const BAR1_INTERVAL_MS = 50;
const BAR1_MAX = 85;
const BAR2_INTERVAL_MS = 70;
const BAR2_MAX = 65;

export function WorkflowLivePanel() {
  const [statusIndex, setStatusIndex] = useState(0);
  const [progress1, setProgress1] = useState(0);
  const [progress2, setProgress2] = useState(0);
  const statusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bar1IntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bar2IntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    statusIntervalRef.current = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUSES.length);
    }, STATUS_CYCLE_MS);
    return () => {
      if (statusIntervalRef.current) clearInterval(statusIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    bar1IntervalRef.current = setInterval(() => {
      setProgress1((p) => (p >= BAR1_MAX ? 0 : p + 1));
    }, BAR1_INTERVAL_MS);
    return () => {
      if (bar1IntervalRef.current) clearInterval(bar1IntervalRef.current);
    };
  }, []);

  useEffect(() => {
    bar2IntervalRef.current = setInterval(() => {
      setProgress2((p) => (p >= BAR2_MAX ? 0 : p + 1));
    }, BAR2_INTERVAL_MS);
    return () => {
      if (bar2IntervalRef.current) clearInterval(bar2IntervalRef.current);
    };
  }, []);

  const status = STATUSES[statusIndex];
  const statusClass = STATUS_STYLES[status];

  return (
    <div className="rounded-xl border border-border bg-card/80 backdrop-blur p-4 shadow-soft">
      <div className="flex justify-between items-center mb-4">
        <span className="text-xs font-medium text-muted-foreground">Live Activity</span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
          <span className="text-[10px] text-accent">Live</span>
        </span>
      </div>
      <div className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground mb-2">Status:</p>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all duration-500 ${statusClass}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-75" />
            {status}
          </span>
        </div>
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-muted-foreground">Monthly Budget</span>
            <span className="text-muted-foreground tabular-nums">{progress1}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-75"
              style={{ width: `${progress1}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-muted-foreground">Spend used</span>
            <span className="text-muted-foreground tabular-nums">{progress2}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-success transition-[width] duration-75"
              style={{ width: `${progress2}%` }}
            />
          </div>
        </div>
      </div>
      <div className="mt-4 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full w-1/3 rounded-full shimmer" />
      </div>
    </div>
  );
}
