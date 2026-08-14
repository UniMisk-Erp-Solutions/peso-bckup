import { Search, Users, Receipt, Clock, Coins, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { formatINR } from "@/lib/format";
import { useTranslation } from "@/i18n";
import { MobileAdminExpenseCard, type AdminExpenseRow } from "./MobileAdminExpenseCard";
import { ExpenseCustomFieldFilters } from "@/components/ExpenseCustomFieldFilters";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FilterableCustomField } from "@/lib/expenseCustomFieldFilters";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import type { OperationStatus } from "@/hooks/useOperationProgress";

type Stats = {
  totalExpenses: number;
  pendingExpenses: number;
  approvedExpenses: number;
  totalAmount: number;
  totalUsers: number;
};

type Props = {
  stats: Stats;
  filteredExpenses: AdminExpenseRow[];
  expensesLoading: boolean;
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  customFieldFilters: Record<string, string>;
  setCustomFieldFilters: (v: Record<string, string>) => void;
  filterableCustomFields: FilterableCustomField[];
  totalExpenseCount: number;
  expenses: AdminExpenseRow[];
  allExpensesLoaded: boolean;
  loadingAllExpenses: boolean;
  onLoadAllExpenses: () => void;
  onSelectExpense: (expense: AdminExpenseRow) => void;
  employeeIdLoginEnabled: boolean;
  loadAllProgressStatus?: OperationStatus;
  loadAllProgressTitle?: string;
  loadAllProgressDescription?: string;
  loadAllProgressCompleted?: number;
  loadAllProgressTotal?: number;
  expenseFetchProgressStatus?: OperationStatus;
  expenseFetchProgressTitle?: string;
  expenseFetchProgressDescription?: string;
  hasCompletedExpenseFetch?: boolean;
  bulkProgressStatus?: OperationStatus;
  bulkProgressTitle?: string;
  bulkProgressDescription?: string;
};

const QUICK_LINKS = [
  { label: "Users", icon: Users, to: "/admin/users" },
  { label: "Reports", icon: Receipt, to: "/admin/reports" },
] as const;

export function MobileAdminExpensesView({
  stats,
  filteredExpenses,
  expensesLoading,
  searchTerm,
  setSearchTerm,
  statusFilter,
  setStatusFilter,
  customFieldFilters,
  setCustomFieldFilters,
  filterableCustomFields,
  totalExpenseCount,
  expenses,
  allExpensesLoaded,
  loadingAllExpenses,
  onLoadAllExpenses,
  onSelectExpense,
  employeeIdLoginEnabled,
  loadAllProgressStatus = "idle",
  loadAllProgressTitle,
  loadAllProgressDescription,
  loadAllProgressCompleted,
  loadAllProgressTotal,
  expenseFetchProgressStatus = "idle",
  expenseFetchProgressTitle,
  expenseFetchProgressDescription,
  hasCompletedExpenseFetch = false,
  bulkProgressStatus = "idle",
  bulkProgressTitle,
  bulkProgressDescription,
}: Props) {
  const { t } = useTranslation(["admin", "expenses"]);
  const navigate = useNavigate();

  return (
    <div className="space-y-4 pb-4">
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 space-y-1">
          <div className="flex items-center gap-1.5">
            <Users className="h-4 w-4 text-blue-600 shrink-0" />
            <span className="text-xs font-medium text-blue-700">{t("admin:panel.stats.totalUsers")}</span>
          </div>
          <p className="text-xl font-bold text-blue-900">{stats.totalUsers}</p>
        </div>
        <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3 space-y-1">
          <div className="flex items-center gap-1.5">
            <Receipt className="h-4 w-4 text-emerald-600 shrink-0" />
            <span className="text-xs font-medium text-emerald-700">{t("admin:panel.stats.totalExpenses")}</span>
          </div>
          <p className="text-xl font-bold text-emerald-900">{stats.totalExpenses}</p>
        </div>
        <div className="rounded-xl bg-yellow-50 border border-yellow-100 p-3 space-y-1">
          <div className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-yellow-600 shrink-0" />
            <span className="text-xs font-medium text-yellow-700">{t("admin:panel.stats.pending")}</span>
          </div>
          <p className="text-xl font-bold text-yellow-900">{stats.pendingExpenses}</p>
        </div>
        <div className="rounded-xl bg-purple-50 border border-purple-100 p-3 space-y-1">
          <div className="flex items-center gap-1.5">
            <Coins className="h-4 w-4 text-purple-600 shrink-0" />
            <span className="text-xs font-medium text-purple-700">{t("admin:panel.stats.totalAmount")}</span>
          </div>
          <p className="text-lg font-bold text-purple-900 truncate">{formatINR(stats.totalAmount)}</p>
        </div>
      </div>

      {/* Quick links */}
      <div className="flex gap-2">
        {QUICK_LINKS.map(({ label, icon: Icon, to }) => (
          <button
            key={to}
            type="button"
            onClick={() => navigate(to)}
            className="flex-1 flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm font-medium active:bg-muted transition-colors"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span>{label}</span>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        ))}
      </div>

      {/* Search + filter */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder={t("admin:panel.searchFilter.searchPlaceholder")}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11"
          />
        </div>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-11">
            <SelectValue placeholder={t("admin:panel.searchFilter.allStatuses")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("admin:panel.searchFilter.allStatuses")}</SelectItem>
            <SelectItem value="submitted">{t("expenses:status.submitted")}</SelectItem>
            <SelectItem value="edited">{t("expenses:status.edited")}</SelectItem>
            <SelectItem value="level_1_verified">{t("expenses:status.level1Verified")}</SelectItem>
            <SelectItem value="level_2_verified">{t("expenses:status.level2Verified")}</SelectItem>
            <SelectItem value="verified">{t("expenses:status.verified")}</SelectItem>
            <SelectItem value="approved">{t("expenses:status.approved")}</SelectItem>
            <SelectItem value="rejected">{t("expenses:status.rejected")}</SelectItem>
          </SelectContent>
        </Select>

        {filterableCustomFields.length > 0 && (
          <ExpenseCustomFieldFilters
            fields={filterableCustomFields}
            values={customFieldFilters}
            onChange={setCustomFieldFilters}
          />
        )}
      </div>

      {/* Load-all banner */}
      {(loadAllProgressStatus !== "idle" || (!allExpensesLoaded && expenses.length < Math.max(totalExpenseCount, expenses.length))) && (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 space-y-2">
          {loadAllProgressStatus !== "idle" && (
            <AsyncOperationProgress
              status={loadAllProgressStatus}
              title={loadAllProgressTitle}
              description={loadAllProgressDescription}
              showSuccess={loadAllProgressStatus === "success"}
            />
          )}
          {!allExpensesLoaded && expenses.length < Math.max(totalExpenseCount, expenses.length) && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Showing {expenses.length.toLocaleString()} of {Math.max(totalExpenseCount, expenses.length).toLocaleString()}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onLoadAllExpenses}
                disabled={loadingAllExpenses}
              >
                {loadingAllExpenses
                  ? t("admin:review.progress.loadingButton", {
                      loaded: loadAllProgressCompleted ?? expenses.length,
                      total: loadAllProgressTotal ?? Math.max(totalExpenseCount, expenses.length),
                    })
                  : t("admin:review.progress.loadAllButton", {
                      total: Math.max(totalExpenseCount, expenses.length),
                    })}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Bulk action progress */}
      {bulkProgressStatus !== "idle" && (
        <AsyncOperationProgress
          status={bulkProgressStatus}
          title={bulkProgressTitle}
          description={bulkProgressDescription}
          showSuccess={bulkProgressStatus === "success"}
        />
      )}

      {/* Expense list */}
      {expensesLoading && expenses.length === 0 && !hasCompletedExpenseFetch ? (
        <div className="py-6">
          <AsyncOperationProgress
            status={expenseFetchProgressStatus !== "idle" ? expenseFetchProgressStatus : "running"}
            title={expenseFetchProgressTitle || t("admin:review.progress.loadingExpenses")}
            description={expenseFetchProgressDescription || t("admin:review.progress.loadingExpensesHint")}
          />
        </div>
      ) : filteredExpenses.length === 0 ? (
        <div
          data-testid="admin-expenses-empty"
          className="flex flex-col items-center justify-center py-12 gap-2 text-center"
        >
          <Receipt className="h-10 w-10 text-muted-foreground" />
          <p className="font-medium text-sm">No expenses match your filters</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            {expenses.length > 0
              ? "Try clearing filters or choosing a different status."
              : "No reviewable expenses were loaded for this organization."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground px-0.5">
            {filteredExpenses.length} expense{filteredExpenses.length !== 1 ? "s" : ""}
          </p>
          {filteredExpenses.map((expense) => (
            <MobileAdminExpenseCard
              key={expense.id}
              expense={expense}
              onSelect={onSelectExpense}
              employeeIdLoginEnabled={employeeIdLoginEnabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
