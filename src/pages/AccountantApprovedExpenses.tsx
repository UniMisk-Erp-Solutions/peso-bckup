import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { expenseRowMatchesSearch } from "@/lib/expenseListSearch";
import { useOrganizationIdentityMode } from "@/hooks/useOrganizationIdentityMode";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCashierCapabilities } from "@/hooks/useCashierCapabilities";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { ExpenseCustomFieldFilters } from "@/components/ExpenseCustomFieldFilters";
import { useExpenseCustomFieldFilters } from "@/hooks/useExpenseCustomFieldFilters";
import {
  fetchExpenseCustomFieldsMap,
  matchesCustomFieldFilters,
} from "@/lib/expenseCustomFieldFilters";
import { ExpenseService } from "@/services/ExpenseService";
import { fetchExpenseSubmitterProfiles } from "@/lib/supabaseInQuery";
import { formatINR, formatCreatedDateTime, parseLocalDate } from "@/lib/format";
import { getDateLocale } from "@/lib/formatLocale";
import { format } from "date-fns";
import { CheckCircle, Filter, Receipt, Search } from "lucide-react";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileAccountantExpensesView } from "@/components/mobile/MobileAccountantExpensesView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";

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

const EXPENSES_PER_PAGE = 15;

export default function AccountantApprovedExpenses() {
  const { t, i18n } = useTranslation(["cashier", "admin", "expenses"]);
  const navigate = useNavigate();
  const { organizationId } = useAuth();
  const { canViewApprovedExpenses } = useCashierCapabilities();
  const { expenseSearchIdentityOptions } = useOrganizationIdentityMode();
  const moneyLocale = getDateLocale(i18n.language);
  const {
    filterableCustomFields,
    customFieldFilters,
    setCustomFieldFilters,
  } = useExpenseCustomFieldFilters(organizationId);

  const [expenses, setExpenses] = useState<ApprovedExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [expenseSort, setExpenseSort] = useState<"newest" | "name_asc" | "name_desc">("newest");
  const [currentPage, setCurrentPage] = useState(1);
  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startLoadProgress(t("admin:panel.loadingExpenses", { defaultValue: "Loading expenses…" }));
    } else if (!loading && wasLoading) {
      completeLoadProgress(t("common:success"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const load = useCallback(async () => {
    if (!organizationId || !canViewApprovedExpenses) return;
    setLoading(true);
    try {
      const { data: expensesData, error } = await supabase
        .from("expenses")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("status", "approved")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = expensesData || [];
      if (rows.length === 0) {
        setExpenses([]);
        return;
      }

      const userIds = [...new Set(rows.map((e) => e.user_id))];
      const profiles = await fetchExpenseSubmitterProfiles(
        supabase,
        organizationId,
        userIds as string[],
      );

      const expenseIds = rows.map((e) => e.id).filter(Boolean) as string[];
      let reviewerCorrectedIds = new Set<string>();
      let customByExpense: Record<string, Record<string, string>> = {};

      try {
        reviewerCorrectedIds = await ExpenseService.getExpenseIdsWithReviewerCorrections(
          expenseIds,
          organizationId,
        );
        customByExpense = await fetchExpenseCustomFieldsMap(organizationId, expenseIds);
      } catch (enrichError) {
        console.error("Expense enrichment failed:", enrichError);
      }

      setExpenses(
        rows.map((expense) => {
          const profile = profiles?.find((p) => p.user_id === expense.user_id);
          const expenseId = String(expense.id ?? "");
          return {
            id: expenseId,
            title: expense.title || "",
            destination: expense.destination || "",
            trip_start: expense.trip_start || expense.created_at,
            status: expense.status,
            total_amount: Number(expense.total_amount ?? 0),
            created_at: expense.created_at,
            user_id: expense.user_id,
            user_name: profile?.name || "Unknown User",
            user_email: profile?.email || "",
            user_balance: profile?.balance ?? 0,
            category: expense.category,
            transaction_number: (expense as { transaction_number?: string }).transaction_number ?? null,
            wasReviewerCorrected: reviewerCorrectedIds.has(expenseId),
            batch_id: expense.batch_id,
            custom_fields: customByExpense[expenseId] ?? {},
          };
        }),
      );
    } catch (err) {
      console.error("Failed to load approved expenses:", err);
      setExpenses([]);
    } finally {
      setLoading(false);
    }
  }, [organizationId, canViewApprovedExpenses]);

  useEffect(() => {
    if (!canViewApprovedExpenses) {
      navigate("/dashboard", { replace: true });
      return;
    }
    void load();
  }, [canViewApprovedExpenses, load, navigate]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, expenseSort, customFieldFilters]);

  const filteredExpenses = useMemo(() => {
    return expenses.filter((expense) => {
      const matchesSearch = expenseRowMatchesSearch(
        {
          ...expense,
          transaction_number: expense.transaction_number,
        },
        searchTerm,
        expenseSearchIdentityOptions,
      );
      const matchesCustomFields = matchesCustomFieldFilters(
        expense.custom_fields,
        customFieldFilters,
      );
      return matchesSearch && matchesCustomFields;
    });
  }, [expenses, searchTerm, customFieldFilters, expenseSearchIdentityOptions]);

  const sortedExpenses = useMemo(() => {
    return [...filteredExpenses].sort((a, b) => {
      if (expenseSort === "name_asc") {
        return a.user_name.localeCompare(b.user_name, undefined, { sensitivity: "base" });
      }
      if (expenseSort === "name_desc") {
        return b.user_name.localeCompare(a.user_name, undefined, { sensitivity: "base" });
      }
      const aDate =
        parseLocalDate(a.trip_start)?.getTime() ?? new Date(a.trip_start).getTime();
      const bDate =
        parseLocalDate(b.trip_start)?.getTime() ?? new Date(b.trip_start).getTime();
      if (bDate !== aDate) return bDate - aDate;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [filteredExpenses, expenseSort]);

  const totalPages = Math.max(1, Math.ceil(sortedExpenses.length / EXPENSES_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safeCurrentPage - 1) * EXPENSES_PER_PAGE;
  const paginatedExpenses = sortedExpenses.slice(
    pageStartIndex,
    pageStartIndex + EXPENSES_PER_PAGE,
  );

  const totalAmount = useMemo(
    () => sortedExpenses.reduce((sum, e) => sum + e.total_amount, 0),
    [sortedExpenses],
  );

  const { isMobile } = useViewportMode();

  if (!canViewApprovedExpenses) return null;

  if (isMobile) {
    return (
      <MobileAccountantExpensesView
        expenses={sortedExpenses}
        loading={loading}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        expenseSort={expenseSort}
        setExpenseSort={setExpenseSort}
        totalAmount={totalAmount}
        approvedCount={sortedExpenses.length}
        onViewExpense={(id) => navigate(`/expenses/${id}`)}
        filterableCustomFields={filterableCustomFields}
        customFieldFilters={customFieldFilters}
        setCustomFieldFilters={setCustomFieldFilters}
      />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          {t("cashier:approvedExpenses.title")}
        </h1>
        <Badge variant="outline" className="border-slate-300 bg-slate-50 text-slate-700">
          {t("cashier:accountantReadOnlyBadge")}
        </Badge>
      </div>

      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2">
        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1 min-w-0 flex-1">
                <p className="text-xs sm:text-sm font-medium text-gray-600 truncate">
                  {t("admin:panel.stats.approved")}
                </p>
                <p className="text-xl sm:text-2xl font-bold text-gray-900">
                  {sortedExpenses.length}
                </p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-r from-green-500 to-emerald-500 rounded-lg flex items-center justify-center shadow-lg flex-shrink-0">
                <CheckCircle className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1 min-w-0 flex-1">
                <p className="text-xs sm:text-sm font-medium text-gray-600 truncate">
                  {t("admin:panel.stats.totalAmount")}
                </p>
                <p className="text-xl sm:text-2xl font-bold text-gray-900 truncate">
                  {formatINR(totalAmount, moneyLocale)}
                </p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-r from-purple-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg flex-shrink-0">
                <Receipt className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm">
        <CardHeader className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-4 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <Filter className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-lg sm:text-xl font-bold">
                {t("admin:panel.searchFilter.title")}
              </CardTitle>
              <CardDescription className="text-blue-100 text-sm">
                {t("cashier:approvedExpenses.description")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 sm:p-6">
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2 sm:col-span-2 lg:col-span-1">
              <label className="text-xs sm:text-sm font-medium text-gray-700">
                {t("admin:panel.searchFilter.search")}
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder={t("admin:panel.searchFilter.searchPlaceholder")}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 h-10 sm:h-12 border-gray-200 text-sm"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs sm:text-sm font-medium text-gray-700">
                {t("admin:panel.searchFilter.sortBy")}
              </label>
              <Select
                value={expenseSort}
                onValueChange={(v) => setExpenseSort(v as typeof expenseSort)}
              >
                <SelectTrigger className="h-10 sm:h-12 border-gray-200 text-sm">
                  <SelectValue placeholder={t("admin:panel.searchFilter.sortPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">{t("admin:panel.searchFilter.newestFirst")}</SelectItem>
                  <SelectItem value="name_asc">{t("admin:panel.searchFilter.nameAsc")}</SelectItem>
                  <SelectItem value="name_desc">{t("admin:panel.searchFilter.nameDesc")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ExpenseCustomFieldFilters
              fields={filterableCustomFields}
              values={customFieldFilters}
              onChange={setCustomFieldFilters}
              className="sm:col-span-2 lg:col-span-3"
            />
          </div>
          <div className="mt-3 sm:mt-4 text-xs sm:text-sm text-gray-600">
            {t("cashier:approvedExpenses.showing", {
              from: sortedExpenses.length === 0 ? 0 : pageStartIndex + 1,
              to: Math.min(pageStartIndex + EXPENSES_PER_PAGE, sortedExpenses.length),
              total: sortedExpenses.length,
              defaultValue: `Showing ${sortedExpenses.length === 0 ? 0 : pageStartIndex + 1}-${Math.min(pageStartIndex + EXPENSES_PER_PAGE, sortedExpenses.length)} of ${sortedExpenses.length} approved expenses`,
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm">
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-lg sm:text-xl font-bold">
            {t("cashier:approvedExpenses.listTitle")}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            {t("cashier:approvedExpenses.listDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6">
          {loadProgress.status !== "idle" && (
            <div className="mb-4">
              <AsyncOperationProgress
                status={loadProgress.status}
                title={loadProgress.phase}
                showSuccess={loadProgress.status === "success"}
                compact={loadProgress.status === "running"}
              />
            </div>
          )}
          {loading ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : sortedExpenses.length === 0 ? (
            <div className="min-h-[240px] flex flex-col items-center justify-center text-center px-4">
              <Receipt className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="font-medium text-gray-900">{t("cashier:approvedExpenses.empty")}</p>
            </div>
          ) : (
            <>
              <div data-testid="accountant-approved-scroll-container" className="relative w-full overflow-x-auto -mx-4 sm:mx-0">
                  <Table noScrollWrapper className="min-w-max">
                    <TableHeader>
                      <TableRow className="border-gray-200">
                        <TableHead className="font-semibold min-w-[80px] whitespace-nowrap">Txn #</TableHead>
                        <TableHead className="font-semibold min-w-[140px]">Employee / Title</TableHead>
                        <TableHead className="font-semibold min-w-[100px] hidden sm:table-cell">Title</TableHead>
                        <TableHead className="font-semibold min-w-[100px] hidden md:table-cell">Category</TableHead>
                        <TableHead className="font-semibold w-[140px] max-w-[140px] hidden sm:table-cell">Destination</TableHead>
                        <TableHead className="font-semibold min-w-[90px] whitespace-nowrap">Amount</TableHead>
                        <TableHead className="font-semibold min-w-[90px] hidden md:table-cell">Balance</TableHead>
                        <TableHead className="font-semibold min-w-[100px] hidden sm:table-cell">Status</TableHead>
                        <TableHead className="font-semibold min-w-[100px] whitespace-nowrap text-right pr-2 sm:pr-4 hidden sm:table-cell">
                          Expense Date
                        </TableHead>
                        <TableHead className="font-semibold min-w-[140px] whitespace-nowrap text-right pr-2 sm:pr-4 hidden md:table-cell">
                          Submitted on
                        </TableHead>
                        <TableHead data-testid="accountant-approved-actions-header" className="sticky right-0 z-30 min-w-[100px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right font-semibold">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedExpenses.map((expense) => (
                        <TableRow key={expense.id} className="group">
                          <TableCell className="text-xs sm:text-sm font-mono font-semibold text-blue-600 whitespace-nowrap">
                            {expense.transaction_number || "-"}
                          </TableCell>
                          <TableCell className="text-xs sm:text-sm">
                            <div>
                              <div className="font-medium truncate">{expense.user_name}</div>
                              <div className="text-xs text-muted-foreground truncate sm:hidden">
                                {expense.user_email}
                              </div>
                              <div className="font-medium text-xs sm:text-sm mt-1 line-clamp-1 break-words">
                                {expense.title}
                              </div>
                              <div className="text-xs text-muted-foreground md:hidden mt-1">
                                Submitted: {formatCreatedDateTime(expense.created_at)}
                              </div>
                              {expense.batch_id && (
                                <Badge variant="outline" className="text-xs mt-1 bg-violet-50 text-violet-700 border-violet-200">
                                  Batch
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="font-medium text-xs sm:text-sm hidden sm:table-cell">
                            <div className="line-clamp-2 break-words">{expense.title}</div>
                          </TableCell>
                          <TableCell className="text-xs sm:text-sm hidden md:table-cell capitalize">
                            {expense.category ?? "-"}
                          </TableCell>
                          <TableCell
                            className="text-xs sm:text-sm truncate hidden sm:table-cell max-w-[140px]"
                            title={expense.destination}
                          >
                            {expense.destination}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs sm:text-sm font-medium">
                            {formatINR(expense.total_amount, moneyLocale)}
                          </TableCell>
                          <TableCell className="text-xs sm:text-sm hidden md:table-cell">
                            <div className="font-medium whitespace-nowrap text-green-600">
                              {formatINR(expense.user_balance, moneyLocale)}
                            </div>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            <ExpenseStatusWithCorrectionBadge
                              status={expense.status}
                              wasReviewerCorrected={expense.wasReviewerCorrected}
                              viewerContext="reviewer"
                            />
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs sm:text-sm text-right pr-2 sm:pr-4 hidden sm:table-cell">
                            {format(
                              parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start),
                              "MMM d, yyyy",
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs sm:text-sm text-right pr-2 sm:pr-4 hidden md:table-cell">
                            {formatCreatedDateTime(expense.created_at)}
                          </TableCell>
                          <TableCell data-testid="accountant-approved-actions-cell" className="sticky right-0 z-20 min-w-[100px] border-l bg-background group-hover:bg-muted text-right">
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-8 px-2 text-xs font-normal whitespace-nowrap"
                              onClick={() => navigate(`/expenses/${expense.id}`)}
                            >
                              View
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
              </div>
              {sortedExpenses.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs sm:text-sm text-gray-600">
                    Page {safeCurrentPage} of {totalPages}
                  </p>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={safeCurrentPage === 1}
                    >
                      Prev
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safeCurrentPage === totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
