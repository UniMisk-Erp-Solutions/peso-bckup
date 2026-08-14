import { format } from "date-fns";
import {
  CheckCircle2,
  Circle,
  CircleDot,
  FileEdit,
  GitBranch,
  MessageSquare,
  Send,
  ShieldCheck,
  UserCheck,
  XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import {
  buildTimelineEvents,
  buildWorkflowSteps,
  type BuildTimelineOptions,
  type TimelineEvent,
  type TimelineWorkflowStep,
} from "@/lib/buildExpenseReviewTimeline";
import {
  formatAuditLogAction,
  getAuditLogStatusColors,
  type EnrichedAuditLog,
} from "@/lib/auditLogDisplay";
import type { ExpenseCorrectionLogEntry } from "@/lib/expenseCorrectionAudit";

export type ExpenseReviewTimelineProps = {
  expense: BuildTimelineOptions["expense"];
  auditLogs: EnrichedAuditLog[];
  correctionLogs?: ExpenseCorrectionLogEntry[];
  hierarchy?: BuildTimelineOptions["hierarchy"];
  roleLabels?: BuildTimelineOptions["roleLabels"];
  assigneeNames?: BuildTimelineOptions["assigneeNames"];
  managerApprovalLimit?: number | null;
  className?: string;
};

function stepIcon(state: TimelineWorkflowStep["state"]) {
  if (state === "completed") return CheckCircle2;
  if (state === "current") return CircleDot;
  if (state === "rejected") return XCircle;
  return Circle;
}

function stepIconClass(state: TimelineWorkflowStep["state"]) {
  if (state === "completed") return "text-green-600";
  if (state === "current") return "text-blue-600";
  if (state === "rejected") return "text-red-600";
  return "text-muted-foreground";
}

function eventIcon(event: TimelineEvent) {
  const action = (event.action ?? "").toLowerCase();
  if (event.kind === "correction") return FileEdit;
  if (action.includes("rejected")) return XCircle;
  if (action.includes("approved")) return ShieldCheck;
  if (action.includes("tier_advanced")) return GitBranch;
  if (action.includes("verified")) return UserCheck;
  if (action.includes("submitted") || action.includes("resubmitted")) return Send;
  if (action.includes("assigned")) return UserCheck;
  if (action.includes("created")) return Circle;
  return MessageSquare;
}

function formatTierAdvanceComment(comment: string | undefined): string | undefined {
  if (!comment) return undefined;
  return comment
    .replace(/Verified at team_leader/gi, "Verified at Team Leader")
    .replace(/Verified at executive/gi, "Verified at Executive")
    .replace(/advanced to team_leader/gi, "sent to Team Leader")
    .replace(/advanced to executive/gi, "sent to Executive")
    .replace(/advanced to engineer/gi, "sent to Manager")
    .replace(/advanced to admin/gi, "sent to Admin");
}

export function ExpenseReviewTimeline({
  expense,
  auditLogs,
  correctionLogs = [],
  hierarchy,
  roleLabels,
  assigneeNames,
  managerApprovalLimit,
  className,
}: ExpenseReviewTimelineProps) {
  const { t, i18n } = useTranslation(["admin", "expenses"]);

  const formatAction = (action: string, comment?: string) => {
    if (action === "tier_advanced") {
      return t("admin:review.timeline.tierAdvanced", {
        defaultValue: "Hierarchy verification step completed",
      });
    }
    const key = `admin:review.timeline.actions.${action}`;
    // i18n is configured with returnEmptyString:false, so `t(key, {defaultValue:""})`
    // returns the raw key (not "") when the key is missing — checking truthiness of
    // that against "" never caught a missing translation. i18n.exists() checks the
    // real presence of the key regardless of that config.
    if (i18n.exists(key)) return t(key);
    return formatAuditLogAction(action);
  };

  const options: BuildTimelineOptions = useMemo(
    () => ({
      expense,
      auditLogs,
      correctionLogs,
      hierarchy,
      roleLabels,
      assigneeNames,
      managerApprovalLimit,
      formatAction,
    }),
    [
      expense,
      auditLogs,
      correctionLogs,
      hierarchy,
      roleLabels,
      assigneeNames,
      managerApprovalLimit,
      t,
    ],
  );

  const workflowSteps = useMemo(() => buildWorkflowSteps(options), [options]);
  const events = useMemo(() => buildTimelineEvents(options), [options]);

  const hasHierarchy = Boolean(hierarchy?.enabled);

  return (
    <div className={cn("space-y-5", className)}>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("admin:review.timeline.currentStatus", { defaultValue: "Current status" })}
        </span>
        <StatusBadge status={expense.status} viewerContext="reviewer" />
        {expense.approval_tier ? (
          <span className="text-xs text-muted-foreground">
            · {t("admin:review.timeline.queue", { defaultValue: "Queue" })}:{" "}
            <span className="font-medium text-foreground">
              {roleLabels?.[expense.approval_tier] ??
                expense.approval_tier.replace(/_/g, " ")}
            </span>
          </span>
        ) : null}
      </div>

      {hasHierarchy ? (
        <div>
          <p className="text-sm font-medium mb-3">
            {t("admin:review.timeline.workflow", { defaultValue: "Approval workflow" })}
          </p>
          <ol className="relative space-y-0 border-l-2 border-muted ml-2 pl-6">
            {workflowSteps.map((step, index) => {
              const Icon = stepIcon(step.state);
              return (
                <li key={step.id} className={cn("pb-5 last:pb-0", index === 0 && "pt-0")}>
                  <span
                    className={cn(
                      "absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full bg-background",
                      stepIconClass(step.state),
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <p
                    className={cn(
                      "text-sm font-medium leading-none",
                      step.state === "current" && "text-blue-700",
                      step.state === "completed" && "text-foreground",
                      step.state === "pending" && "text-muted-foreground",
                      step.state === "rejected" && "text-red-700",
                    )}
                  >
                    {step.id === "verified"
                      ? step.label
                      : t(`admin:review.timeline.steps.${step.id}`, {
                          defaultValue: step.label,
                        })}
                  </p>
                  {step.detail ? (
                    <p className="text-xs text-muted-foreground mt-1">{step.detail}</p>
                  ) : null}
                  {step.state === "pending" ? (
                    <p className="text-xs text-muted-foreground/80 mt-0.5">
                      {t("admin:review.timeline.notReached", { defaultValue: "Not reached yet" })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <div>
        <p className="text-sm font-medium mb-3">
          {t("admin:review.timeline.activity", { defaultValue: "Activity log" })}
        </p>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground rounded-lg border border-dashed p-4">
            {t("admin:review.timeline.noActivity", {
              defaultValue: "No activity recorded yet for this expense.",
            })}
          </p>
        ) : (
          <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {events.map((event, index) => {
              const colors = getAuditLogStatusColors(event.action ?? event.title);
              const Icon = eventIcon(event);
              const description =
                event.kind === "audit" && event.action === "tier_advanced"
                  ? formatTierAdvanceComment(event.description)
                  : event.description;

              return (
                <li
                  key={event.id}
                  className={cn(
                    "flex gap-3 rounded-lg border p-3 text-sm",
                    colors.bg,
                    colors.border,
                  )}
                >
                  <div className="flex flex-col items-center shrink-0">
                    <div
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border",
                        colors.text,
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                    </div>
                    {index < events.length - 1 ? (
                      <div className={cn("w-px flex-1 min-h-3 mt-1", colors.line)} aria-hidden />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className={cn("font-semibold leading-snug", colors.text)}>
                      {event.title}
                    </p>
                    {description ? (
                      <p className="text-xs break-words opacity-90">{description}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {event.actor ? (
                        <>
                          {t("admin:review.timeline.by", { defaultValue: "by" })}{" "}
                          <span className="font-medium text-foreground">{event.actor}</span>
                          {" · "}
                        </>
                      ) : null}
                      {format(new Date(event.createdAt), "MMM d, yyyy · h:mm a")}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** @deprecated Use ExpenseReviewTimeline for review dialogs */
export { ExpenseReviewTimeline as ExpenseTimeline };
