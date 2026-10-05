import { useState } from "react";
import { BarChart3, Check, CheckCircle2, ClipboardCheck, FileText, Settings2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProductPreviewShell } from "./ProductPreviewShell";
import { formatDemoINR } from "./demoData";

export const TOUR_STEPS = [
  { id: "configure", label: "Configure", icon: Settings2, blurb: "An admin decides which fields a category needs and who reviews it." },
  { id: "submit", label: "Submit", icon: FileText, blurb: "The employee captures the expense with receipts and project details." },
  { id: "review", label: "Review", icon: ClipboardCheck, blurb: "Supervisors, team leaders, engineers or executives review where configured." },
  { id: "approve", label: "Approve", icon: CheckCircle2, blurb: "The authorized approver approves with the full context in front of them." },
  { id: "report", label: "Report", icon: BarChart3, blurb: "Finance sees it in dashboards and audit-ready reports." },
] as const;

const AMOUNT = 4850;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

function Panel({ stepId }: { stepId: (typeof TOUR_STEPS)[number]["id"] }) {
  switch (stepId) {
    case "configure":
      return (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category: Fuel</p>
          {["Vehicle Number", "Odometer", "Project"].map((f, i) => (
            <div key={f} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm">
              <span className="text-foreground">{f}</span>
              <span className="text-xs text-muted-foreground">{i === 2 ? "Required" : "Shown on submit and review"}</span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Review path: Team Leader, then Admin</p>
        </div>
      );
    case "submit":
      return (
        <div>
          <Row label="Category" value="Fuel" />
          <Row label="Amount" value={formatDemoINR(AMOUNT)} />
          <Row label="Vehicle Number" value="GJ-01-AB-1234" />
          <Row label="Project" value="North Plant Upgrade" />
          <Row label="Receipt" value="Fuel bill (photo)" />
        </div>
      );
    case "review":
      return (
        <div className="space-y-3">
          <Row label="Submitted by" value="Aarav Shah" />
          <Row label="Project" value="North Plant Upgrade" />
          <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
            <ClipboardCheck className="h-4 w-4 shrink-0" aria-hidden /> Team Leader reviewed. Forwarded to Admin.
          </div>
        </div>
      );
    case "approve":
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
            <Check className="h-4 w-4 shrink-0" aria-hidden /> Approved
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
            <span className="flex items-center gap-2 text-muted-foreground"><Wallet className="h-4 w-4" aria-hidden /> Balance updated</span>
            <span className="font-semibold tabular-nums text-foreground">{formatDemoINR(42000)} → {formatDemoINR(42000 - AMOUNT)}</span>
          </div>
        </div>
      );
    default:
      return (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[420px] border-collapse text-xs">
            <thead>
              <tr className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                {["Employee", "Date", "Expense Type", "Project Name", "Debit"].map((h) => (
                  <th key={h} className="border-b-2 border-border px-3 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="bg-primary/5">
                <td className="px-3 py-2">Aarav Shah</td>
                <td className="px-3 py-2">16-09-2026</td>
                <td className="px-3 py-2">Fuel</td>
                <td className="px-3 py-2">North Plant Upgrade</td>
                <td className="px-3 py-2 tabular-nums">{formatDemoINR(AMOUNT)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      );
  }
}

/** A miniature guided product tour around ONE fictional expense. Local state only. */
export function InteractiveHowItWorksTour({ className }: { className?: string }) {
  const [index, setIndex] = useState(0);
  const step = TOUR_STEPS[index];
  const Icon = step.icon;

  return (
    <ProductPreviewShell title="Guided tour" className={className}>
      <p className="mb-3 text-xs text-muted-foreground">
        One expense, start to finish: <span className="font-medium text-foreground">{formatDemoINR(AMOUNT)} · Fuel · North Plant Upgrade</span>
      </p>
      <ol className="grid grid-cols-5 gap-1.5" aria-label="Workflow steps">
        {TOUR_STEPS.map((s, i) => {
          const SIcon = s.icon;
          return (
            <li key={s.id} className="min-w-0">
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-current={i === index ? "step" : undefined}
                aria-label={`Step ${i + 1}: ${s.label}`}
                className={cn(
                  "flex w-full min-w-0 flex-col items-center gap-1 overflow-hidden rounded-lg border px-0.5 py-2 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-xs",
                  i === index ? "border-primary bg-primary text-primary-foreground" : i < index ? "border-success/40 bg-success/10 text-success" : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                <SIcon className="h-4 w-4" aria-hidden />
                <span className="max-w-full truncate">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 min-h-[190px]" data-testid="demo-tour-panel" aria-live="polite">
        <div className="mb-3 flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Icon className="h-4 w-4 text-primary" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground" data-testid="demo-tour-title">
              {index + 1}. {step.label}
            </p>
            <p className="text-xs text-muted-foreground">{step.blurb}</p>
          </div>
        </div>
        <Panel stepId={step.id} />
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setIndex((i) => Math.max(i - 1, 0))} disabled={index === 0}>
          Back
        </Button>
        <Button size="sm" className="flex-1" onClick={() => setIndex((i) => Math.min(i + 1, TOUR_STEPS.length - 1))} disabled={index === TOUR_STEPS.length - 1}>
          {index === TOUR_STEPS.length - 1 ? "That's the flow" : `Next: ${TOUR_STEPS[index + 1].label}`}
        </Button>
      </div>
    </ProductPreviewShell>
  );
}
