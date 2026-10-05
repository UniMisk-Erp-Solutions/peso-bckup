import { useState } from "react";
import { Check, Circle, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProductPreviewShell } from "./ProductPreviewShell";
import { APPROVAL_AMOUNT, APPROVAL_STAGES, APPROVAL_START_BALANCE, formatDemoINR } from "./demoData";

export function approvalStatus(step: number): "Submitted" | "Under review" | "Verified" | "Approved" {
  if (step >= APPROVAL_STAGES.length - 1) return "Approved";
  if (step >= 2) return "Verified";
  if (step >= 1) return "Under review";
  return "Submitted";
}

const badgeTone: Record<string, string> = {
  Submitted: "bg-muted text-muted-foreground",
  "Under review": "bg-warning/15 text-warning",
  Verified: "bg-info/15 text-info",
  Approved: "bg-success/15 text-success",
};

/**
 * Interactive approval path: "Next step" moves a fictional expense through
 * optional review tiers to final approval, where the balance updates. Local
 * state only; the tiers shown are examples of what an organization can configure.
 */
export function InteractiveApprovalWorkflow({ className }: { className?: string }) {
  const [step, setStep] = useState(0); // index of the last COMPLETED stage
  const last = APPROVAL_STAGES.length - 1;
  const done = step >= last;
  const status = approvalStatus(step);
  const balance = done ? APPROVAL_START_BALANCE - APPROVAL_AMOUNT : APPROVAL_START_BALANCE;

  return (
    <ProductPreviewShell title="Expense review" className={className}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Site Purchase · Aarav Shah</p>
          <p className="text-lg font-bold tabular-nums text-foreground">{formatDemoINR(APPROVAL_AMOUNT)}</p>
        </div>
        <span
          className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", badgeTone[status])}
          data-testid="demo-approval-status"
          role="status"
        >
          {status}
        </span>
      </div>

      <ol className="mt-4 space-y-0" aria-label="Approval path">
        {APPROVAL_STAGES.map((s, i) => {
          const complete = i <= step;
          const current = i === step + 1;
          return (
            <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0" aria-current={current ? "step" : undefined}>
              {i < APPROVAL_STAGES.length - 1 ? (
                <span
                  className={cn("absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px", complete && i < step ? "bg-success" : "bg-border")}
                  aria-hidden
                />
              ) : null}
              <span
                className={cn(
                  "z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs",
                  complete
                    ? "border-success bg-success text-success-foreground"
                    : current
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground",
                )}
              >
                {complete ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Circle className="h-3 w-3" aria-hidden />}
              </span>
              <div className="min-w-0">
                <p className={cn("text-sm font-medium", complete || current ? "text-foreground" : "text-muted-foreground")}>{s.label}</p>
                <p className="text-xs text-muted-foreground">{complete ? s.note : s.actor}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <div
        className={cn(
          "mt-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
          done ? "border-success/40 bg-success/10 text-success" : "border-border bg-muted/30 text-muted-foreground",
        )}
        data-testid="demo-approval-balance"
      >
        <Wallet className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{done ? "Balance updated" : "Balance"}</span>
        <span className="font-semibold tabular-nums">{formatDemoINR(balance)}</span>
      </div>

      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={() => setStep((s) => Math.min(s + 1, last))} disabled={done} className="flex-1">
          {done ? "Approved" : "Next step"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setStep(0)} disabled={step === 0}>
          Reset
        </Button>
      </div>
    </ProductPreviewShell>
  );
}
