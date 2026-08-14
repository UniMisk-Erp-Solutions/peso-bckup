import { Badge } from "@/components/ui/badge";
import { formatINR, parseLocalDate } from "@/lib/format";
import { format } from "date-fns";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { ChevronRight } from "lucide-react";

export type AdminExpenseRow = {
  id: string;
  title: string;
  destination: string;
  trip_start: string;
  trip_end: string;
  status: string;
  total_amount: number;
  created_at: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_employee_id: string;
  user_balance: number;
  transaction_number?: string | null;
  batch_id?: string | null;
  isResubmitted?: boolean;
  wasReviewerCorrected?: boolean;
  category?: string | null;
  purpose?: string | null;
  admin_comment?: string;
  assigned_engineer_id?: string;
  assigned_reviewer_id?: string;
  approval_tier?: string | null;
  updated_at?: string;
  custom_fields?: Record<string, string>;
};

type Props = {
  expense: AdminExpenseRow;
  onSelect: (expense: AdminExpenseRow) => void;
  employeeIdLoginEnabled: boolean;
};

export function MobileAdminExpenseCard({ expense, onSelect, employeeIdLoginEnabled }: Props) {
  const subline = employeeIdLoginEnabled
    ? (expense.user_employee_id?.trim() || "—")
    : (expense.user_employee_id?.trim() || expense.user_email || "—");

  return (
    <button
      type="button"
      data-testid="admin-expense-card"
      className="mobile-admin-expense-card w-full text-left p-4 bg-card border border-border rounded-xl shadow-sm active:bg-muted transition-colors"
      onClick={() => onSelect(expense)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm">{expense.user_name}</span>
            {expense.batch_id && (
              <Badge variant="outline" className="text-xs bg-violet-50 text-violet-700 border-violet-200">
                Batch
              </Badge>
            )}
            {expense.isResubmitted && expense.status === "submitted" && (
              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                Resubmitted
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">{subline}</p>
          <p className="text-sm font-medium truncate">{expense.title}</p>
          {expense.destination ? (
            <p className="text-xs text-muted-foreground truncate">{expense.destination}</p>
          ) : null}
          <div className="flex items-center gap-3 pt-0.5">
            <span className="text-sm font-semibold">{formatINR(expense.total_amount)}</span>
            <span className="text-xs text-muted-foreground">
              {format(
                parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start),
                "MMM d, yyyy",
              )}
            </span>
          </div>
          {expense.transaction_number ? (
            <p className="text-xs font-mono text-blue-600 mt-0.5">{expense.transaction_number}</p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0 pt-0.5">
          <ExpenseStatusWithCorrectionBadge
            status={expense.status}
            wasReviewerCorrected={expense.wasReviewerCorrected}
            viewerContext="reviewer"
          />
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </button>
  );
}
