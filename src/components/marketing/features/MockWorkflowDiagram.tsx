import { FileText, Search, ThumbsUp, Wallet, CheckCircle, ChevronRight } from "lucide-react";

const steps = [
  { icon: FileText, label: "Submit", bg: "bg-primary text-primary-foreground" },
  { icon: Search, label: "Verify", bg: "bg-warning text-warning-foreground" },
  { icon: ThumbsUp, label: "Approve", bg: "bg-accent text-accent-foreground" },
  { icon: Wallet, label: "Deduct", bg: "bg-info text-info-foreground" },
  { icon: CheckCircle, label: "Done", bg: "bg-primary text-primary-foreground" },
];

export function MockWorkflowDiagram() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-soft">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">
        Approval Workflow
      </p>
      <div className="flex items-center justify-center gap-1 flex-wrap">
        {steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <div key={i} className="flex items-center gap-1">
              <div className="flex flex-col items-center">
                <div
                  className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${step.bg}`}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <span className="mt-2 text-[10px] font-medium text-muted-foreground">{step.label}</span>
              </div>
              {i < steps.length - 1 && (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-1.5 w-3/5 rounded-full bg-gradient-to-r from-primary to-accent animate-shimmer" />
      </div>
    </div>
  );
}
