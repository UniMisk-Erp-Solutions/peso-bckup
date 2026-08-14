import { ExpenseReviewTimeline } from "@/components/ExpenseReviewTimeline";
import type { EnrichedAuditLog } from "@/lib/auditLogDisplay";

/**
 * Backward-compatible wrapper used by legacy pages (e.g. ExpenseDetail).
 * Prefer importing and using `ExpenseReviewTimeline` directly for new code.
 */
export function ExpenseTimeline({ logs = [] }: { logs?: EnrichedAuditLog[] }) {
  return (
    <ExpenseReviewTimeline
      expense={{ status: "submitted", approval_tier: null }}
      auditLogs={logs}
      hierarchy={{ enabled: false, teamLeader: false, executive: false }}
    />
  );
}

export { ExpenseReviewTimeline };
