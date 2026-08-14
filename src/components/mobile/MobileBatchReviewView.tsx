import { Layers } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatINR, parseLocalDate } from "@/lib/format";
import { format } from "date-fns";
import { MobileBatchLineCard } from "@/components/mobile/MobileBatchLineCard";
import type { BatchReviewExpenseRow, BatchReviewRole } from "@/lib/batchExpenseReview";
import type { BatchExpenseReviewBatchInfo } from "@/components/BatchExpenseReviewPanel";

interface MobileBatchReviewViewProps {
  batch: BatchExpenseReviewBatchInfo;
  expenses: BatchReviewExpenseRow[];
  submitterName: string;
  role: BatchReviewRole;
  onSelectExpense: (expense: BatchReviewExpenseRow) => void;
}

export function MobileBatchReviewView({
  batch,
  expenses,
  submitterName,
  onSelectExpense,
}: MobileBatchReviewViewProps) {
  const pendingCount = expenses.filter(
    (e) => e.status !== "approved" && e.status !== "rejected",
  ).length;

  const batchDate = parseLocalDate(batch.shared_expense_date) ?? new Date(batch.shared_expense_date);

  return (
    <div className="space-y-4">
      <Card className="border-blue-200 bg-blue-50/50">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-blue-700" />
            {batch.label ?? "Expense batch"}
          </CardTitle>
          <CardDescription className="text-xs">
            {format(batchDate, "MMM d, yyyy")} · {batch.shared_category} · {submitterName}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-6 text-sm pt-0">
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="font-semibold">{formatINR(batch.total_amount)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Lines</p>
            <p className="font-semibold">{expenses.length}</p>
          </div>
          {pendingCount > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">Pending</p>
              <p className="font-semibold text-amber-700">{pendingCount}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        {expenses.length === 0 ? (
          <p className="text-center text-muted-foreground text-sm py-8">
            No expenses in this batch.
          </p>
        ) : (
          expenses.map((exp) => (
            <MobileBatchLineCard
              key={exp.id}
              expense={exp}
              onSelect={() => onSelectExpense(exp)}
            />
          ))
        )}
      </div>
    </div>
  );
}
