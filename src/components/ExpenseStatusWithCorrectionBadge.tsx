import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";

const POST_REVIEWER_EDIT_STATUSES = new Set(["approved", "verified", "paid"]);

type ViewerContext = "owner" | "reviewer";

interface ExpenseStatusWithCorrectionBadgeProps {
  status: string;
  /** True when this expense has at least one row in `expense_correction_logs`. */
  wasReviewerCorrected?: boolean;
  viewerContext?: ViewerContext;
}

/**
 * Shows workflow status plus a persistent "Reviewer adjusted" pill when the expense
 * was corrected while in review and later reached approved / verified / paid.
 */
export function ExpenseStatusWithCorrectionBadge({
  status,
  wasReviewerCorrected,
  viewerContext = "reviewer",
}: ExpenseStatusWithCorrectionBadgeProps) {
  const s = (status || "").toLowerCase();
  const showAdjustedPill =
    wasReviewerCorrected === true && POST_REVIEWER_EDIT_STATUSES.has(s);

  return (
    <div className="flex flex-wrap items-center gap-1.5 justify-end sm:justify-start">
      <StatusBadge status={status as any} viewerContext={viewerContext} />
      {showAdjustedPill ? (
        <Badge
          variant="outline"
          className="text-xs font-medium bg-amber-50 text-amber-900 border-amber-200"
          title="A manager or reviewer changed expense details before this status was reached."
        >
          Reviewer adjusted
        </Badge>
      ) : null}
    </div>
  );
}
