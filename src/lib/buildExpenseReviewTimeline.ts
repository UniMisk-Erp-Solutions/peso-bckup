import type { ApprovalTier } from "@/lib/approvalHierarchy";
import type { EnrichedAuditLog } from "@/lib/auditLogDisplay";
import type { ExpenseCorrectionLogEntry } from "@/lib/expenseCorrectionAudit";

export type TimelineStepState = "completed" | "current" | "pending" | "rejected" | "skipped";

export type TimelineWorkflowStep = {
  id: string;
  label: string;
  state: TimelineStepState;
  detail?: string;
};

export type TimelineEventKind = "audit" | "correction" | "system";

export type TimelineEvent = {
  id: string;
  kind: TimelineEventKind;
  title: string;
  description?: string;
  actor?: string;
  createdAt: string;
  action?: string;
};

export type ExpenseTimelineContext = {
  status: string;
  total_amount?: number | null;
  approval_tier?: string | null;
  assigned_reviewer_id?: string | null;
  assigned_engineer_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type BuildTimelineOptions = {
  expense: ExpenseTimelineContext;
  auditLogs: EnrichedAuditLog[];
  correctionLogs?: ExpenseCorrectionLogEntry[];
  hierarchy?: {
    enabled: boolean;
    teamLeader: boolean;
    executive: boolean;
  };
  roleLabels?: Partial<Record<string, string>>;
  assigneeNames?: {
    reviewer?: string | null;
    engineer?: string | null;
  };
  managerApprovalLimit?: number | null;
  formatAction?: (action: string, comment?: string) => string;
};

const TIER_LABEL_KEYS: Record<string, string> = {
  team_leader: "team_leader",
  executive: "executive",
  engineer: "engineer",
  admin: "admin",
};

function statusRank(status: string): number {
  const order = [
    "draft",
    "submitted",
    "edited",
    "level_1_verified",
    "level_2_verified",
    "verified",
    "approved",
    "rejected",
  ];
  const i = order.indexOf(status);
  return i >= 0 ? i : 0;
}

function tierLabel(
  tier: string | null | undefined,
  roleLabels?: Partial<Record<string, string>>,
): string {
  if (!tier) return "Reviewer";
  const key = TIER_LABEL_KEYS[tier] ?? tier;
  return roleLabels?.[key] ?? tier.replace(/_/g, " ");
}

const STEP_STATUS_THRESHOLD: Record<string, string> = {
  submitted: "submitted",
  level_1: "level_1_verified",
  level_2: "level_2_verified",
  verified: "verified",
  approved: "approved",
};

function resolveCurrentStepId(
  options: BuildTimelineOptions,
  stepIds: string[],
): string | null {
  const { expense, hierarchy } = options;
  const status = expense.status;
  const currentTier = expense.approval_tier as ApprovalTier | null | undefined;

  if (status === "approved") return null;
  if (status === "rejected") return null;

  if (status === "verified") return stepIds.includes("approved") ? "approved" : null;
  if (status === "level_2_verified") {
    return stepIds.includes("verified") ? "verified" : null;
  }
  if (status === "level_1_verified") {
    if (stepIds.includes("level_2")) return "level_2";
    return stepIds.includes("verified") ? "verified" : null;
  }

  if (status === "submitted" || status === "edited") {
    if (currentTier === "team_leader" && stepIds.includes("level_1")) return "level_1";
    if (currentTier === "executive" && stepIds.includes("level_2")) return "level_2";
    if (currentTier === "engineer" && stepIds.includes("verified")) return "verified";
    if (currentTier === "admin" && stepIds.includes("approved")) return "approved";
    if (hierarchy?.enabled && hierarchy.teamLeader && stepIds.includes("level_1")) {
      return "level_1";
    }
    if (hierarchy?.enabled && hierarchy.executive && stepIds.includes("level_2")) {
      return "level_2";
    }
    if (stepIds.includes("verified")) return "verified";
    if (stepIds.includes("approved")) return "approved";
    return stepIds.includes("submitted") ? "submitted" : null;
  }

  return null;
}

export function buildWorkflowSteps(options: BuildTimelineOptions): TimelineWorkflowStep[] {
  const expense = options.expense ?? { status: "submitted", approval_tier: null };
  const { hierarchy, roleLabels, assigneeNames, managerApprovalLimit } = options;
  const status = expense.status;
  const rank = statusRank(status);
  const rejected = status === "rejected";
  const amount = Number(expense.total_amount ?? 0);
  const limit =
    managerApprovalLimit !== null &&
    managerApprovalLimit !== undefined &&
    Number.isFinite(Number(managerApprovalLimit))
      ? Number(managerApprovalLimit)
      : null;
  const limitReached = limit !== null && limit > 0 && amount > limit;

  const steps: TimelineWorkflowStep[] = [
    { id: "submitted", label: "Submitted", state: "pending" },
  ];

  if (hierarchy?.enabled && hierarchy.teamLeader) {
    steps.push({ id: "level_1", label: "Level 1 verified", state: "pending" });
  }
  if (hierarchy?.enabled && hierarchy.executive) {
    steps.push({ id: "level_2", label: "Level 2 verified", state: "pending" });
  }

  steps.push(
    {
      id: "verified",
      label: limitReached ? "Level 3 verified (Manager)" : "Manager verified",
      state: "pending",
    },
    { id: "approved", label: "Approved", state: "pending" },
  );

  const stepIds = steps.map((s) => s.id);
  const currentStepId = resolveCurrentStepId(options, stepIds);

  for (const step of steps) {
    const threshold = STEP_STATUS_THRESHOLD[step.id];
    const thresholdRank = statusRank(threshold);

    if (rejected) {
      step.state = rank >= thresholdRank && step.id === "submitted" ? "completed" : "rejected";
      continue;
    }

    if (rank >= statusRank("approved") || (step.id === "approved" && status === "approved")) {
      step.state = "completed";
      continue;
    }

    if (rank >= thresholdRank && step.id !== currentStepId) {
      step.state = "completed";
      continue;
    }

    if (step.id === currentStepId) {
      step.state = "current";
      const currentTier = (expense.approval_tier as string | null) ?? null;
      const assignee =
        step.id === "verified" || currentTier === "engineer"
          ? assigneeNames?.reviewer || assigneeNames?.engineer || null
          : assigneeNames?.reviewer || assigneeNames?.engineer || null;
      const tierText = tierLabel(
        currentTier,
        roleLabels,
      );
      step.detail = assignee
        ? `Waiting on ${assignee} (${tierText})`
        : `Waiting at ${tierText} step`;
      continue;
    }

    step.state = "pending";
  }

  return steps;
}

export function buildTimelineEvents(options: BuildTimelineOptions): TimelineEvent[] {
  const { auditLogs, correctionLogs = [], formatAction } = options;
  const events: TimelineEvent[] = [];

  for (const log of auditLogs) {
    events.push({
      id: `audit-${log.action}-${log.created_at}`,
      kind: "audit",
      action: log.action,
      title: formatAction ? formatAction(log.action, log.comment) : log.action,
      description: log.comment,
      actor: log.user_name,
      createdAt: log.created_at,
    });
  }

  for (const log of correctionLogs) {
    events.push({
      id: `correction-${log.id}`,
      kind: "correction",
      title: "Expense adjusted by reviewer",
      description: log.reason ?? undefined,
      actor: log.edited_by,
      createdAt: log.created_at,
    });
  }

  events.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return events;
}
