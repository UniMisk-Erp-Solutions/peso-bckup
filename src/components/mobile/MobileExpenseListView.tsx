import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { MobileExpenseCard, MobileExpenseItem } from "./MobileExpenseCard";
import { MobileExpenseListFilters } from "./MobileExpenseListFilters";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import type { OperationStatus } from "@/hooks/useOperationProgress";
import { formatExpenseMonthLabel, type ExpenseMonthOption, type ExpenseMonthValue } from "@/lib/expenseMonthFilter";

interface Props {
  filteredExpenses: MobileExpenseItem[];
  loading: boolean;
  enrichingExpenses: boolean;
  searchTerm: string;
  onSearchChange: (s: string) => void;
  statusFilter: string;
  onStatusFilterChange: (s: string) => void;
  totalExpenseCount: number;
  allExpensesLoaded: boolean;
  onLoadAll: () => void;
  loadingAllExpenses: boolean;
  loadAllProgressStatus?: OperationStatus;
  loadAllProgressTitle?: string;
  loadAllProgressDescription?: string;
  /** Exact-month mode (§43): applies immediately, switches to server pagination. */
  expenseMonth?: ExpenseMonthValue;
  monthOptions?: ExpenseMonthOption[];
  onExpenseMonthChange?: (v: ExpenseMonthValue) => void;
  monthModeTotal?: number;
  monthModePage?: number;
  monthModeTotalPages?: number;
  monthModeLoading?: boolean;
  monthModeError?: string | null;
  onMonthPageChange?: (page: number) => void;
}

function ExpenseListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function MobileExpenseListView({
  filteredExpenses,
  loading,
  enrichingExpenses,
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  totalExpenseCount,
  allExpensesLoaded,
  onLoadAll,
  loadingAllExpenses,
  loadAllProgressStatus = "idle",
  loadAllProgressTitle,
  loadAllProgressDescription,
  expenseMonth = "all",
  monthOptions = [{ value: "all", label: "All months" }],
  onExpenseMonthChange = () => {},
  monthModeTotal = 0,
  monthModePage = 1,
  monthModeTotalPages = 0,
  monthModeLoading = false,
  monthModeError = null,
  onMonthPageChange = () => {},
}: Props) {
  const navigate = useNavigate();
  const isExactMonthMode = expenseMonth !== "all";
  const hasActiveFilter = statusFilter !== "all" || searchTerm.trim() !== "";
  const effectiveLoading = isExactMonthMode ? monthModeLoading && filteredExpenses.length === 0 : loading;

  return (
    <div className="flex flex-col gap-4">
      <MobileExpenseListFilters
        searchTerm={searchTerm}
        onSearchChange={onSearchChange}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
        expenseMonth={expenseMonth}
        monthOptions={monthOptions}
        onExpenseMonthChange={onExpenseMonthChange}
      />

      {effectiveLoading ? (
        <ExpenseListSkeleton />
      ) : isExactMonthMode && monthModeError ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <p className="text-sm font-medium text-destructive">{monthModeError}</p>
          <Button variant="outline" size="sm" onClick={() => onMonthPageChange(monthModePage)}>
            Retry
          </Button>
        </div>
      ) : isExactMonthMode && filteredExpenses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <p className="text-sm font-medium text-foreground">
            No expenses found for {formatExpenseMonthLabel(expenseMonth)}.
          </p>
        </div>
      ) : filteredExpenses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          {hasActiveFilter ? (
            <>
              <p className="text-sm font-medium text-foreground">No results found</p>
              <p className="text-xs text-muted-foreground">
                Try adjusting your search or filters
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  onSearchChange("");
                  onStatusFilterChange("all");
                }}
              >
                Clear filters
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">No expenses yet</p>
              <p className="text-xs text-muted-foreground">
                Start by submitting your first expense
              </p>
              <Button
                size="sm"
                className="mt-2 gap-1.5"
                onClick={() => navigate("/expenses/new")}
              >
                <Plus className="h-4 w-4" />
                New Expense
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {isExactMonthMode && (
            <p className="text-xs text-muted-foreground">
              {monthModeTotal.toLocaleString()} expense{monthModeTotal === 1 ? "" : "s"} in{" "}
              {formatExpenseMonthLabel(expenseMonth)}
              {monthModeLoading ? " (updating…)" : ""}
            </p>
          )}
          {filteredExpenses.map((expense) => (
            <MobileExpenseCard key={expense.id} expense={expense} />
          ))}

          {isExactMonthMode ? (
            monthModeTotalPages > 1 && (
              <div className="mt-1 flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onMonthPageChange(Math.max(1, monthModePage - 1))}
                  disabled={monthModePage <= 1 || monthModeLoading}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {monthModePage} of {monthModeTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onMonthPageChange(Math.min(monthModeTotalPages, monthModePage + 1))}
                  disabled={monthModePage >= monthModeTotalPages || monthModeLoading}
                >
                  Next
                </Button>
              </div>
            )
          ) : (
            (loadAllProgressStatus !== "idle" || (!allExpensesLoaded && totalExpenseCount > filteredExpenses.length)) && (
              <div className="space-y-2 mt-1">
                {loadAllProgressStatus !== "idle" && (
                  <AsyncOperationProgress
                    status={loadAllProgressStatus}
                    title={loadAllProgressTitle}
                    description={loadAllProgressDescription}
                    showSuccess={loadAllProgressStatus === "success"}
                  />
                )}
                {!allExpensesLoaded && totalExpenseCount > filteredExpenses.length && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={onLoadAll}
                    disabled={loadingAllExpenses}
                  >
                    {loadingAllExpenses
                      ? (loadAllProgressTitle ?? "Loading…")
                      : `Load all ${totalExpenseCount} expenses`}
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
