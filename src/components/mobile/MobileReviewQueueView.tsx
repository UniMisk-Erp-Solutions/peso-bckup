import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { MobileReviewExpenseCard } from "./MobileReviewExpenseCard";
import type { Expense } from "@/pages/EngineerReview";

type Props = {
  expenses: Expense[];
  loading: boolean;
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  timePeriod: string;
  setTimePeriod: (v: string) => void;
  managerFetchWarning: string | null;
  isPendingForCurrentReviewer: (exp: Expense) => boolean;
  formatSubline: (exp: Expense) => string;
  onSelectExpense: (expense: Expense) => void;
  isSelectableForBulk?: (exp: Expense) => boolean;
  /** Selected keys (expense:<id> | batch:<batch_id>) — matches the desktop model. */
  selectedKeys?: Set<string>;
  /** Selection key for a row; a batch child returns its batch key. */
  selectionKeyOf?: (exp: Expense) => string;
  onToggleSelect?: (exp: Expense, checked: boolean) => void;
  bulkActionLoading?: boolean;
};

export function MobileReviewQueueView({
  expenses,
  loading,
  searchTerm,
  setSearchTerm,
  statusFilter,
  setStatusFilter,
  timePeriod,
  setTimePeriod,
  managerFetchWarning,
  isPendingForCurrentReviewer,
  formatSubline,
  onSelectExpense,
  isSelectableForBulk,
  selectedKeys = new Set<string>(),
  selectionKeyOf = (exp) => (exp.batch_id ? `batch:${exp.batch_id}` : `expense:${exp.id}`),
  onToggleSelect = () => {},
  bulkActionLoading = false,
}: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Review Queue</h1>
        <span className="text-xs text-muted-foreground">{expenses.length} expense{expenses.length !== 1 ? "s" : ""}</span>
      </div>

      {managerFetchWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          {managerFetchWarning}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, title…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Filters row */}
      <div className="flex gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="flex-1 text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="submitted">Submitted</SelectItem>
            <SelectItem value="under_review">Under review</SelectItem>
            <SelectItem value="verified">Verified</SelectItem>
            <SelectItem value="level_1_verified">L1 Verified</SelectItem>
            <SelectItem value="level_2_verified">L2 Verified</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="edited">Edited</SelectItem>
          </SelectContent>
        </Select>

        <Select value={timePeriod} onValueChange={setTimePeriod}>
          <SelectTrigger className="flex-1 text-xs">
            <SelectValue placeholder="Period" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="3m">Last 3 months</SelectItem>
            <SelectItem value="6m">Last 6 months</SelectItem>
            <SelectItem value="1y">Last year</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : expenses.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground text-sm">
          {searchTerm || statusFilter !== "all"
            ? "No expenses match the current filters."
            : "No expenses assigned to you."}
        </div>
      ) : (
        <div className="space-y-2 pb-4">
          {expenses.map((expense) => (
            <MobileReviewExpenseCard
              key={expense.id}
              expense={expense}
              isPending={isPendingForCurrentReviewer(expense)}
              isSelectable={isSelectableForBulk ? isSelectableForBulk(expense) : (isPendingForCurrentReviewer(expense) && !expense.batch_id && expense.status !== "approved" && expense.status !== "rejected")}
              isSelected={selectedKeys.has(selectionKeyOf(expense))}
              onToggleSelect={(checked) => onToggleSelect(expense, checked)}
              selectionDisabled={bulkActionLoading}
              formatSubline={formatSubline}
              onSelect={() => onSelectExpense(expense)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
