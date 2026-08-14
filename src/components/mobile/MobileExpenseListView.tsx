import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { MobileExpenseCard, MobileExpenseItem } from "./MobileExpenseCard";
import { MobileExpenseListFilters } from "./MobileExpenseListFilters";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import type { OperationStatus } from "@/hooks/useOperationProgress";

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
}: Props) {
  const navigate = useNavigate();
  const hasActiveFilter = statusFilter !== "all" || searchTerm.trim() !== "";

  return (
    <div className="flex flex-col gap-4">
      <MobileExpenseListFilters
        searchTerm={searchTerm}
        onSearchChange={onSearchChange}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
      />

      {loading ? (
        <ExpenseListSkeleton />
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
          {filteredExpenses.map((expense) => (
            <MobileExpenseCard key={expense.id} expense={expense} />
          ))}

          {(loadAllProgressStatus !== "idle" || (!allExpensesLoaded && totalExpenseCount > filteredExpenses.length)) && (
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
          )}
        </div>
      )}
    </div>
  );
}
