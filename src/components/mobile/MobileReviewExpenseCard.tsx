import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { formatINR } from "@/lib/format";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { isTerminalReviewStatus, reviewRowState } from "@/lib/reviewStatePresentation";
import type { Expense } from "@/pages/EngineerReview";

type Props = {
  expense: Expense;
  isPending: boolean;
  isSelectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (checked: boolean) => void;
  selectionDisabled?: boolean;
  formatSubline: (expense: Expense) => string;
  onSelect: () => void;
};

export function MobileReviewExpenseCard({
  expense,
  isPending,
  isSelectable,
  isSelected,
  onToggleSelect,
  selectionDisabled,
  formatSubline,
  onSelect,
}: Props) {
  const date = expense.trip_start
    ? new Date(expense.trip_start).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "—";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      className="mobile-review-card"
    >
      {/* TOP ROW: checkbox (if selectable) + title + amount */}
      <div className="flex items-start justify-between gap-2">
        {isSelectable && (
          <div
            className="shrink-0 pt-0.5"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={!!isSelected}
              onCheckedChange={(checked) => onToggleSelect?.(!!checked)}
              disabled={selectionDisabled}
              aria-label="Select expense"
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{expense.title}</div>
        </div>
        <div className="text-sm font-bold tabular-nums shrink-0 ml-1">{formatINR(expense.total_amount)}</div>
      </div>

      {/* SECONDARY IDENTITY: employee name + email/ID */}
      <div className="mt-1 min-w-0">
        <div className="text-xs font-medium truncate">{expense.user_name}</div>
        <div
          className="text-xs text-muted-foreground truncate"
          title={expense.user_email}
          aria-label={expense.user_email}
        >
          {formatSubline(expense)}
        </div>
      </div>

      {/* CONTEXT ROW: status, category, date, badges */}
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <ExpenseStatusWithCorrectionBadge
          status={expense.status}
          wasReviewerCorrected={expense.wasReviewerCorrected}
        />
        {expense.category && (
          <span className="text-[10px] text-muted-foreground capitalize">{expense.category}</span>
        )}
        <span className="text-[10px] text-muted-foreground">{date}</span>
        {expense.batch_id && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Batch</Badge>
        )}
        {(expense as { isResubmitted?: boolean }).isResubmitted && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-400 text-amber-700">Resubmitted</Badge>
        )}
        {isPending && (
          <Badge className="text-[10px] px-1.5 py-0 bg-blue-600">Action needed</Badge>
        )}
        {/* Parity with the desktop 3-state (§3): a row that is visible but still
            sitting at an earlier hierarchy stage is WAITING (amber) — distinct
            from finished (grey, no badge) and from ready (blue, above). */}
        {reviewRowState({ isReadyNow: isPending, isTerminal: isTerminalReviewStatus(expense.status) }) ===
          "waiting" && (
          <Badge className="text-[10px] px-1.5 py-0 bg-amber-500 hover:bg-amber-600">Waiting</Badge>
        )}
      </div>
    </div>
  );
}
