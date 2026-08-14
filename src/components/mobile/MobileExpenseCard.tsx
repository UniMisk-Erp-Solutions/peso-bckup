import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatINR, parseLocalDate } from "@/lib/format";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";

export interface MobileExpenseItem {
  id: string;
  title: string;
  destination?: string | null;
  trip_start?: string | null;
  status: string;
  total_amount: number;
  created_at?: string | null;
  isResubmitted?: boolean;
  wasReviewerCorrected?: boolean;
  batch_id?: string | null;
  category?: string | null;
}

interface Props {
  expense: MobileExpenseItem;
}

export function MobileExpenseCard({ expense }: Props) {
  const navigate = useNavigate();

  const parsedDate: Date | null = expense.trip_start
    ? parseLocalDate(expense.trip_start)
    : expense.created_at
    ? new Date(expense.created_at)
    : null;
  const dateStr = parsedDate ? format(parsedDate, "dd MMM yyyy") : null;

  const showResubmit =
    expense.isResubmitted === true &&
    (expense.status === "submitted" || expense.status === "edited");

  return (
    <button
      type="button"
      className="w-full text-left bg-card border border-border rounded-xl px-4 py-3.5 flex flex-col gap-2 active:scale-[0.99] transition-transform"
      onClick={() => navigate(`/expenses/${expense.id}`)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm text-foreground leading-snug truncate">
            {expense.title}
          </p>
          {expense.destination && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {expense.destination}
            </p>
          )}
        </div>
        <span className="font-semibold text-sm text-foreground shrink-0 tabular-nums">
          {formatINR(expense.total_amount)}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {showResubmit ? (
          <Badge
            variant="outline"
            className="text-xs py-0 h-5 bg-blue-50 text-blue-700 border-blue-200"
          >
            Resubmitted
          </Badge>
        ) : (
          <ExpenseStatusWithCorrectionBadge
            status={expense.status}
            wasReviewerCorrected={expense.wasReviewerCorrected}
            viewerContext="owner"
          />
        )}
        {expense.batch_id && (
          <Badge variant="outline" className="text-xs py-0 h-5 gap-1">
            <Layers className="h-3 w-3" />
            Batch
          </Badge>
        )}
        {expense.category && (
          <span className="text-xs text-muted-foreground capitalize">
            {expense.category}
          </span>
        )}
        {dateStr && (
          <span className="text-xs text-muted-foreground ml-auto">
            {dateStr}
          </span>
        )}
      </div>
    </button>
  );
}
