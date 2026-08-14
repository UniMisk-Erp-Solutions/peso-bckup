import { format } from "date-fns";
import { Search, Receipt } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { ExpenseCustomFieldFilters } from "@/components/ExpenseCustomFieldFilters";
import { formatINR, parseLocalDate } from "@/lib/format";

type ApprovedExpense = {
  id: string;
  title: string;
  destination: string;
  trip_start: string;
  status: string;
  total_amount: number;
  created_at: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_balance: number;
  category?: string | null;
  transaction_number?: string | null;
  wasReviewerCorrected?: boolean;
  batch_id?: string | null;
  custom_fields?: Record<string, string>;
};

interface Props {
  expenses: ApprovedExpense[];
  loading: boolean;
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  expenseSort: "newest" | "name_asc" | "name_desc";
  setExpenseSort: (v: "newest" | "name_asc" | "name_desc") => void;
  totalAmount: number;
  approvedCount: number;
  onViewExpense: (id: string) => void;
  filterableCustomFields: { id: string; name: string; field_type: string; options?: string[] | null }[];
  customFieldFilters: Record<string, string[]>;
  setCustomFieldFilters: (v: Record<string, string[]>) => void;
}

export function MobileAccountantExpensesView({
  expenses,
  loading,
  searchTerm,
  setSearchTerm,
  expenseSort,
  setExpenseSort,
  totalAmount,
  approvedCount,
  onViewExpense,
  filterableCustomFields,
  customFieldFilters,
  setCustomFieldFilters,
}: Props) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-green-50 rounded-xl p-3 border border-green-100">
          <p className="text-xs text-muted-foreground">Approved</p>
          <p className="text-xl font-bold text-green-700">{approvedCount}</p>
        </div>
        <div className="bg-purple-50 rounded-xl p-3 border border-purple-100">
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="text-base font-bold text-purple-700 truncate">{formatINR(totalAmount)}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>
        <Select value={expenseSort} onValueChange={(v) => setExpenseSort(v as typeof expenseSort)}>
          <SelectTrigger className="h-9 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="name_asc">Name A–Z</SelectItem>
            <SelectItem value="name_desc">Name Z–A</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filterableCustomFields.length > 0 && (
        <ExpenseCustomFieldFilters
          fields={filterableCustomFields}
          values={customFieldFilters}
          onChange={setCustomFieldFilters}
        />
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      ) : expenses.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2"
          data-testid="accountant-expenses-empty"
        >
          <Receipt className="h-10 w-10 opacity-30" />
          <p className="text-sm">No approved expenses</p>
        </div>
      ) : (
        <div className="space-y-3">
          {expenses.map((expense) => (
            <button
              key={expense.id}
              type="button"
              className="w-full text-left rounded-xl border bg-card p-4 shadow-sm hover:bg-muted/30 transition-colors mobile-accountant-expense-card"
              data-testid="accountant-expense-card"
              onClick={() => onViewExpense(expense.id)}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{expense.user_name}</p>
                  <p className="text-xs text-muted-foreground truncate">{expense.user_email}</p>
                </div>
                <ExpenseStatusWithCorrectionBadge
                  status={expense.status}
                  wasReviewerCorrected={expense.wasReviewerCorrected}
                  viewerContext="reviewer"
                />
              </div>
              <p className="text-sm font-medium line-clamp-1 mb-1">{expense.title}</p>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-base font-bold">{formatINR(expense.total_amount)}</span>
                <span className="text-xs text-muted-foreground">
                  {format(
                    parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start),
                    "MMM d, yyyy",
                  )}
                </span>
              </div>
              {expense.category && (
                <p className="text-xs text-muted-foreground mt-1 capitalize">{expense.category}</p>
              )}
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {expense.transaction_number && (
                  <span className="text-xs font-mono text-blue-600">
                    {expense.transaction_number}
                  </span>
                )}
                {expense.batch_id && (
                  <Badge
                    variant="outline"
                    className="text-xs bg-violet-50 text-violet-700 border-violet-200"
                  >
                    Batch
                  </Badge>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
