import { useState, useCallback } from "react";
import { CheckCircle, XCircle } from "lucide-react";

const MESSAGE_DURATION_MS = 10_000;

type ViewState = "form" | "confirmed" | "canceled";

export function MockBalanceTransfer() {
  const [viewState, setViewState] = useState<ViewState>("form");

  const showConfirmed = useCallback(() => {
    setViewState("confirmed");
    const t = setTimeout(() => setViewState("form"), MESSAGE_DURATION_MS);
    return () => clearTimeout(t);
  }, []);

  const showCanceled = useCallback(() => {
    setViewState("canceled");
    const t = setTimeout(() => setViewState("form"), MESSAGE_DURATION_MS);
    return () => clearTimeout(t);
  }, []);

  if (viewState === "confirmed") {
    return (
      <div className="rounded-xl border border-border bg-card p-8 shadow-soft text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-success/10 flex items-center justify-center">
            <CheckCircle className="h-6 w-6 text-success" />
          </div>
          <h3 className="text-base font-semibold text-foreground">Transfer confirmed</h3>
          <p className="text-sm text-muted-foreground">
            ₹ 25,000 has been transferred to Branch A — expense fund. This message will disappear in 10 seconds.
          </p>
        </div>
      </div>
    );
  }

  if (viewState === "canceled") {
    return (
      <div className="rounded-xl border border-border bg-card p-8 shadow-soft text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
            <XCircle className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold text-foreground">Transfer canceled</h3>
          <p className="text-sm text-muted-foreground">
            No funds were moved. This message will disappear in 10 seconds.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
      <h3 className="text-sm font-semibold text-foreground mb-4">Balance Transfer</h3>
      <div className="flex items-center gap-4">
        <div className="flex-1 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">From</p>
          <p className="text-xs font-medium text-foreground">Main Treasury</p>
          <p className="text-sm font-bold text-foreground">₹ 250,000.00</p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-1.5 w-[80%] rounded-full bg-primary" />
          </div>
        </div>
        <div className="flex flex-col items-center">
          <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-sm">
            →
          </div>
          <span className="text-[10px] font-medium text-primary mt-1">₹ 25,000</span>
        </div>
        <div className="flex-1 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">To</p>
          <p className="text-xs font-medium text-foreground">Branch A — expense fund</p>
          <p className="text-sm font-bold text-foreground">₹ 45,230.00</p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-1.5 w-[40%] rounded-full bg-accent" />
          </div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={showCanceled}
          className="flex-1 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={showConfirmed}
          className="flex-1 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Confirm Transfer
        </button>
      </div>
    </div>
  );
}
