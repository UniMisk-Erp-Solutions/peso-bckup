import type { BatchReviewExpenseRow } from "@/lib/batchExpenseReview";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { formatINR } from "@/lib/format";
import { ChevronRight } from "lucide-react";

interface MobileBatchLineCardProps {
  expense: BatchReviewExpenseRow;
  onSelect: () => void;
}

export function MobileBatchLineCard({ expense, onSelect }: MobileBatchLineCardProps) {
  return (
    <button
      type="button"
      className="mobile-batch-line-card w-full text-left"
      onClick={onSelect}
      aria-label={`View details for ${expense.title}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm truncate">{expense.title}</p>
          {expense.category && (
            <p className="text-xs text-muted-foreground capitalize mt-0.5">{expense.category}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-sm font-semibold tabular-nums">{formatINR(expense.total_amount)}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <ExpenseStatusWithCorrectionBadge
          status={expense.status}
          wasReviewerCorrected={expense.wasReviewerCorrected}
          viewerContext="reviewer"
        />
        {expense.transaction_number && (
          <span className="text-xs font-mono text-muted-foreground">
            #{expense.transaction_number}
          </span>
        )}
      </div>
    </button>
  );
}
