import { useState, useCallback } from "react";
import { CheckCircle, FileText } from "lucide-react";
import type { MockExpenseFormData } from "./MockExpenseForm";

const MESSAGE_DURATION_MS = 5_000;

const initialSteps = [
  { label: "Draft", status: "completed" as const, time: "Jan 10, 9:00 AM", actor: "Maria Santos", comment: null },
  { label: "Submitted", status: "completed" as const, time: "Jan 10, 9:05 AM", actor: "Maria Santos", comment: null },
  { label: "Under Review", status: "completed" as const, time: "Jan 10, 2:30 PM", actor: "Eng. Cruz", comment: null },
  {
    label: "Verified",
    status: "current" as const,
    time: "Jan 11, 10:00 AM",
    actor: "Eng. Cruz",
    comment: "All receipts verified. Forwarding for approval.",
  },
  { label: "Approved", status: "pending" as const, time: null, actor: null, comment: null },
];

type StepStatus = "completed" | "current" | "pending";

interface Step {
  label: string;
  status: StepStatus;
  time: string | null;
  actor: string | null;
  comment: string | null;
}

function nextSteps(steps: Step[]): Step[] {
  const currentIndex = steps.findIndex((s) => s.status === "current");
  if (currentIndex === -1) return steps;
  return steps.map((s, i) => {
    if (i < currentIndex) return { ...s, status: "completed" as StepStatus };
    if (i === currentIndex) return { ...s, status: "completed" as StepStatus };
    if (i === currentIndex + 1) return { ...s, status: "current" as StepStatus };
    return s;
  });
}

interface MockApprovalTimelineProps {
  /** Submitted expense from the form (shown as preview when simulating approval) */
  submittedExpense?: MockExpenseFormData | null;
}

export function MockApprovalTimeline({ submittedExpense }: MockApprovalTimelineProps) {
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [approved, setApproved] = useState(false);

  const currentIndex = steps.findIndex((s) => s.status === "current");
  const isLastStep = currentIndex === steps.length - 1;

  const handleAdvance = useCallback(() => {
    if (approved) return;
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
    if (isLastStep && lastStep?.status === "current") {
      setSteps((prev) =>
        prev.map((s, i) =>
          i === prev.length - 1 ? { ...s, status: "completed" as StepStatus } : s
        )
      );
      setApproved(true);
      const t = setTimeout(() => {
        setApproved(false);
        setSteps(initialSteps.map((s) => ({ ...s })));
      }, MESSAGE_DURATION_MS);
      return () => clearTimeout(t);
    }
    setSteps(nextSteps);
  }, [isLastStep, steps, approved]);

  const showExpensePreview = !!submittedExpense;

  if (approved) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 shadow-soft text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-success/10 flex items-center justify-center">
            <CheckCircle className="h-6 w-6 text-success" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">Approved!</h3>
          {submittedExpense && (
            <div className="w-full mt-3 rounded-lg border border-border bg-muted/30 p-3 text-left">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Approved expense</p>
              <p className="text-xs font-medium text-foreground">{submittedExpense.title}</p>
              <p className="text-[10px] text-muted-foreground">{submittedExpense.vendor} • {submittedExpense.category}</p>
              <p className="text-sm font-bold text-foreground mt-1">{submittedExpense.amount}</p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            This demo will reset in a few seconds.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-semibold text-foreground">Approval Timeline</h3>
        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
          In Progress
        </span>
      </div>

      {showExpensePreview && submittedExpense && (
        <div className="mb-4 rounded-lg border border-border bg-muted/30 p-3 flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">{submittedExpense.title}</p>
            <p className="text-[10px] text-muted-foreground">{submittedExpense.vendor} • {submittedExpense.category}</p>
            <p className="text-sm font-bold text-foreground mt-0.5">{submittedExpense.amount}</p>
          </div>
        </div>
      )}

      {!submittedExpense && (
        <p className="text-[10px] text-muted-foreground mb-3 italic">
          Submit an expense in the form to see it here.
        </p>
      )}

      <div className="space-y-0">
        {steps.map((step, i) => (
          <div key={i} className="relative flex gap-3">
            {i < steps.length - 1 && (
              <div
                className="absolute left-[9px] top-5 bottom-0 w-0.5 -translate-y-1/2"
                style={{
                  height: "calc(100% + 8px)",
                  background: step.status === "completed" ? "hsl(var(--accent))" : "hsl(var(--border))",
                }}
              />
            )}
            <div className="relative z-10 flex flex-col items-center shrink-0">
              {step.status === "completed" && (
                <div className="h-5 w-5 rounded-full bg-accent flex items-center justify-center text-[10px] text-accent-foreground">
                  ✓
                </div>
              )}
              {step.status === "current" && (
                <div className="h-5 w-5 rounded-full bg-warning flex items-center justify-center text-[10px] text-warning-foreground animate-pulse-dot">
                  ●
                </div>
              )}
              {step.status === "pending" && (
                <div className="h-5 w-5 rounded-full bg-muted border-2 border-border" />
              )}
            </div>
            <div className="flex-1 pb-4">
              <p
                className={`text-xs font-medium ${step.status === "pending" ? "text-muted-foreground" : "text-foreground"}`}
              >
                {step.label}
              </p>
              {step.time && (
                <p className="text-[10px] text-muted-foreground">{step.time}</p>
              )}
              {step.actor && (
                <p className="text-[10px] text-muted-foreground">by {step.actor}</p>
              )}
              {step.comment && (
                <div className="mt-2 rounded-lg bg-muted/50 p-2 text-[10px] italic text-muted-foreground">
                  &quot;{step.comment}&quot;
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-border">
        <button
          type="button"
          onClick={handleAdvance}
          className="w-full rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {currentIndex >= 0 && currentIndex < steps.length - 1
            ? "Simulate next step"
            : "Mark as approved"}
        </button>
      </div>
    </div>
  );
}
