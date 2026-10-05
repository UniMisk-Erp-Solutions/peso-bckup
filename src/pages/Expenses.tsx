import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useAllowCashierExpenseSubmission } from "@/hooks/useAllowCashierExpenseSubmission";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Filter, Download, ArrowLeft, MoreVertical, Edit, Trash2, Undo2 } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { canOwnerEditExpenseStatus, canOwnerTrashExpenseStatus, canOwnerWithdrawExpenseStatus } from "@/lib/expenseEditRules";
import { withdrawSubmittedExpense } from "@/lib/expenseWithdrawAndDelete";
import { trashExpense } from "@/lib/expenseRecycleBin";
import { ExpenseRecycleBinPanel } from "@/components/ExpenseRecycleBinPanel";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { format } from "date-fns";
import { formatINR, formatCreatedDateTime, parseLocalDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { ExpenseService } from "@/services/ExpenseService";
import { ExpenseCustomFieldFilters } from "@/components/ExpenseCustomFieldFilters";
import { fetchExpenseCustomFieldsMap, matchesCustomFieldFilters } from "@/lib/expenseCustomFieldFilters";
import { expenseRowMatchesSearch } from "@/lib/expenseListSearch";
import { fetchResubmittedExpenseIds } from "@/lib/supabaseInQuery";
import {
  readPersistedExpensesCache,
  writePersistedExpensesCache,
} from "@/lib/expensesListCache";
import { useExpenseCustomFieldFilters } from "@/hooks/useExpenseCustomFieldFilters";
import { SubmitExpenseActions } from "@/components/SubmitExpenseActions";
import { ExpenseSavedDraftsPanel } from "@/components/ExpenseSavedDraftsPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileExpenseListView } from "@/components/mobile/MobileExpenseListView";
import type { MobileExpenseItem } from "@/components/mobile/MobileExpenseCard";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import {
  ALL_MONTHS,
  buildExpenseMonthOptions,
  expenseMonthBounds,
  expenseMonthOfDateString,
  formatExpenseMonthLabel,
  type ExpenseMonthOption,
  type ExpenseMonthValue,
} from "@/lib/expenseMonthFilter";
import { CUSTOM_FIELD_FILTER_ALL } from "@/lib/expenseCustomFieldFilters";
import { validateMyExpensesPageResponse } from "@/lib/myExpensesPageSchema";
import { createMonthFetchGuardState, invalidateMonthFetch, runMonthFetch } from "@/lib/monthFetchGuard";

interface Expense {
  id: string;
  user_id?: string;
  title: string;
  destination: string;
  trip_start: string;
  trip_end: string;
  status: string;
  total_amount: number;
  created_at: string;
  isResubmitted?: boolean;
  wasReviewerCorrected?: boolean;
  custom_fields?: Record<string, string>;
}

type ExpensesListCacheEntry = {
  expenses: Expense[];
  totalCount: number;
  allLoaded: boolean;
};

const expensesListCache = new Map<string, ExpensesListCacheEntry>();

function readExpensesCache(userId: string | undefined): ExpensesListCacheEntry | undefined {
  if (!userId) return undefined;
  // In-memory hit (same-session navigation) — fastest.
  const inMemory = expensesListCache.get(userId);
  if (inMemory) return inMemory;
  // Cold start / after refresh: hydrate from localStorage so the list paints instantly
  // while a fresh fetch revalidates in the background (stale-while-revalidate).
  const persisted = readPersistedExpensesCache<Expense>(userId);
  if (persisted) {
    expensesListCache.set(userId, persisted);
    return persisted;
  }
  return undefined;
}

/** Update both the in-memory and the persisted (localStorage) expenses-list cache. */
function writeExpensesCache(userId: string | undefined, entry: ExpensesListCacheEntry): void {
  if (!userId) return;
  expensesListCache.set(userId, entry);
  writePersistedExpensesCache<Expense>(userId, entry);
}

export default function Expenses() {
  const { t } = useTranslation(["expenses", "common"]);
  const { user, userRole, organizationId, userBalance, refreshBalance } = useAuth();
  const {
    filterableCustomFields,
    customFieldFilters,
    setCustomFieldFilters,
  } = useExpenseCustomFieldFilters(organizationId);
  const { allowCashierExpenseSubmission } = useAllowCashierExpenseSubmission();
  const { toast } = useToast();
  const initialCache = readExpensesCache(user?.id);
  const [expenses, setExpenses] = useState<Expense[]>(() => initialCache?.expenses ?? []);
  const [filteredExpenses, setFilteredExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(() => !initialCache);
  const [loadingAllExpenses, setLoadingAllExpenses] = useState(false);
  const [allExpensesLoaded, setAllExpensesLoaded] = useState(() => initialCache?.allLoaded ?? false);
  const [totalExpenseCount, setTotalExpenseCount] = useState(() => initialCache?.totalCount ?? 0);
  const [enrichingExpenses, setEnrichingExpenses] = useState(false);

  const {
    progress: loadAllProgress,
    startOperation: startLoadAll,
    updateOperation: updateLoadAll,
    completeOperation: completeLoadAll,
  } = useOperationProgress();
  const prevLoadingAllRef = useRef(false);
  const prevEnrichingRef = useRef(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("trip_start");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  /**
   * Exact MONTH+YEAR filter on trip_start. Applies immediately (this page has
   * no draft/apply split at all -- every other filter here already applies on
   * every keystroke/change), and switches the list from the existing bounded-
   * fetch-then-client-filter model to TRUE server-paged browsing via
   * get_my_expenses_page_v1 -- required because a month can hold far more
   * rows than this page's default 150-row initial fetch (or even the full
   * "Load all" set for a heavy account).
   */
  const [expenseMonth, setExpenseMonth] = useState<ExpenseMonthValue>(ALL_MONTHS);
  const [monthOptions, setMonthOptions] = useState<ExpenseMonthOption[]>([
    { value: ALL_MONTHS, label: "All months" },
  ]);
  const [monthModePage, setMonthModePage] = useState(1);
  const [monthModeTotal, setMonthModeTotal] = useState(0);
  const [monthModeTotalPages, setMonthModeTotalPages] = useState(0);
  const [monthModeLoading, setMonthModeLoading] = useState(false);
  const [monthModeError, setMonthModeError] = useState<string | null>(null);
  const isExactMonthMode = expenseMonth !== ALL_MONTHS;
  const MY_EXPENSES_MONTH_PAGE_SIZE = 25;
  // Race-condition hardening (§1-4): the guard's generation token is bumped
  // the INSTANT the user leaves/changes exact-month mode (in
  // handleExpenseMonthChange), not just inside fetchMyExpensesMonthPage --
  // otherwise a switch back to "All months" before an in-flight request
  // resolves never invalidates it, and the stale response can land later and
  // overwrite the correct list. See src/lib/monthFetchGuard.ts for the
  // extracted, unit-tested invalidation logic. `isExactMonthModeRef` backs
  // the guard's commit-time mode check: an exact-month response has zero
  // authority once back in All-months mode, independent of sequence numbers.
  const monthFetchGuardRef = useRef(createMonthFetchGuardState());
  const isExactMonthModeRef = useRef(isExactMonthMode);
  useEffect(() => {
    isExactMonthModeRef.current = isExactMonthMode;
  }, [isExactMonthMode]);
  // Invalidate and cancel any in-flight month fetch on unmount so a late
  // response never calls setState on an unmounted page.
  useEffect(() => {
    return () => {
      invalidateMonthFetch(monthFetchGuardRef.current);
    };
  }, []);
  const [returnMoneyDialogOpen, setReturnMoneyDialogOpen] = useState(false);
  const [returnAmount, setReturnAmount] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [returningMoney, setReturningMoney] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [expenseToDelete, setExpenseToDelete] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
  const [expenseToWithdraw, setExpenseToWithdraw] = useState<Expense | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [expensesTab, setExpensesTab] = useState<"all" | "drafts" | "trash">("all");
  const [savedDraftsCount, setSavedDraftsCount] = useState(0);
  const [trashedCount, setTrashedCount] = useState(0);
  const [trashRefreshToken, setTrashRefreshToken] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const tab = (location.state as { expensesTab?: "all" | "drafts" | "trash" } | null)?.expensesTab;
    if (tab === "drafts" || tab === "trash") {
      setExpensesTab(tab);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  useEffect(() => {
    if (user?.id) {
      void fetchExpenses();
    }
  }, [user?.id]);

  useEffect(() => {
    // Exact-month mode owns filteredExpenses via the server-paged fetch below;
    // the client-side filter must not overwrite it with a filtered slice of
    // (possibly stale/incomplete) `expenses`. Returning to "All months" must
    // still re-run this immediately, hence expenseMonth is a dependency.
    if (isExactMonthMode) return;
    filterAndSortExpenses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenses, searchTerm, statusFilter, sortBy, sortOrder, customFieldFilters, isExactMonthMode]);

  /**
   * Discover the Month dropdown's calendar range from THIS employee's own
   * accessible history -- two 1-row queries (earliest/latest trip_start),
   * never a full scan. Runs once per user/org.
   */
  useEffect(() => {
    if (!user?.id || !organizationId) return;
    let cancelled = false;
    (async () => {
      try {
        // No draft exclusion here (§10-11): the All-months list (fetchExpenses
        // + filterAndSortExpenses) never excludes status='draft' either, so
        // the Month dropdown's range must cover the same population -- a
        // draft-only earliest/latest month must still appear as an option,
        // or selecting it would show a truthful empty state instead of
        // silently omitting a month that has real rows in All-months mode.
        const [{ data: earliestRow }, { data: latestRow }] = await Promise.all([
          supabase
            .from("expenses")
            .select("trip_start")
            .eq("user_id", user.id)
            .eq("organization_id", organizationId)
            .is("deleted_at", null) // DOC-129: a trashed expense's month shouldn't appear as a selectable range
            .order("trip_start", { ascending: true })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("expenses")
            .select("trip_start")
            .eq("user_id", user.id)
            .eq("organization_id", organizationId)
            .is("deleted_at", null) // DOC-129
            .order("trip_start", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        setMonthOptions(
          buildExpenseMonthOptions({
            earliest: earliestRow?.trip_start ? expenseMonthOfDateString(earliestRow.trip_start) : null,
            now: new Date(),
            latestExpenseMonth: latestRow?.trip_start ? expenseMonthOfDateString(latestRow.trip_start) : null,
          }),
        );
      } catch (error) {
        if (cancelled) return;
        console.error("Could not resolve the My Expenses month range:", error);
        setMonthOptions([{ value: ALL_MONTHS, label: "All months" }]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, organizationId]);

  /** Server-paged, server-filtered fetch for exact-month mode (§26/§29). */
  const fetchMyExpensesMonthPage = async (page: number) => {
    if (!user?.id || !organizationId) return;
    const bounds = expenseMonthBounds(expenseMonth);
    if (!bounds) return;
    setMonthModeLoading(true);
    setMonthModeError(null);
    const outcome = await runMonthFetch(
      monthFetchGuardRef.current,
      () => isExactMonthModeRef.current,
      async (signal) => {
        const customFiltersArr = Object.entries(customFieldFilters)
          .filter(([, v]) => v && v !== CUSTOM_FIELD_FILTER_ALL && String(v).trim() !== "")
          .map(([label, value]) => ({ label, value }));
        const client = supabase as unknown as {
          rpc: (
            n: string,
            p: Record<string, unknown>,
          ) => Promise<{ data: unknown; error: { message?: string } | null }> & {
            abortSignal: (
              s: AbortSignal,
            ) => Promise<{ data: unknown; error: { message?: string } | null }>;
          };
        };
        const rpcCall = client.rpc("get_my_expenses_page_v1", {
          p_organization_id: organizationId,
          p_page: page,
          p_page_size: MY_EXPENSES_MONTH_PAGE_SIZE,
          p_status: statusFilter === "all" ? null : statusFilter,
          p_search: searchTerm.trim() || null,
          p_sort_by: sortBy,
          p_sort_order: sortOrder,
          p_date_from: bounds.from,
          p_date_to_exclusive: bounds.toExclusive,
          p_custom_filters: customFiltersArr,
        });
        const { data, error } = await (signal ? rpcCall.abortSignal(signal) : rpcCall);
        if (error) throw new Error(error.message ?? "Failed to load expenses for this month.");
        return validateMyExpensesPageResponse(data);
      },
    );

    // A superseded/aborted request must never touch filteredExpenses/monthMode*
    // state (§1-4) -- the newer request (or the mode change itself) already
    // owns that state.
    if (outcome.kind === "stale" || outcome.kind === "aborted") return;

    if (outcome.kind === "success") {
      setFilteredExpenses(outcome.data.items as unknown as Expense[]);
      setMonthModeTotal(outcome.data.filtered_total);
      setMonthModeTotalPages(outcome.data.total_pages);
      setMonthModePage(outcome.data.page || page);
    } else {
      console.error("Could not load expenses for the selected month:", outcome.error);
      setMonthModeError(
        outcome.error instanceof Error
          ? outcome.error.message
          : "Failed to load expenses for this month.",
      );
      setFilteredExpenses([]);
      setMonthModeTotal(0);
      setMonthModeTotalPages(0);
    }
    setMonthModeLoading(false);
  };

  // Debounced so typing in Search doesn't fire a request per keystroke; every
  // other month-mode filter change (status/sort/custom fields/page) is a
  // single discrete action and fetches immediately.
  useEffect(() => {
    if (!isExactMonthMode) return;
    const t = setTimeout(() => {
      void fetchMyExpensesMonthPage(monthModePage);
    }, searchTerm ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isExactMonthMode,
    expenseMonth,
    statusFilter,
    searchTerm,
    sortBy,
    sortOrder,
    customFieldFilters,
    monthModePage,
    organizationId,
    user?.id,
  ]);

  /**
   * Month is applied immediately and always resets to page 1 (§28).
   *
   * Race fix (§1-4): invalidate the current generation token and abort any
   * in-flight month request IMMEDIATELY, synchronously, before the mode/
   * month state itself changes. This is what closes the gap that let a
   * switch back to "All months" (which never calls fetchMyExpensesMonthPage
   * again) leave a prior in-flight response able to land later and overwrite
   * the correct list -- the token bump no longer waits for a new fetch to
   * happen at all.
   */
  const handleExpenseMonthChange = (value: string) => {
    invalidateMonthFetch(monthFetchGuardRef.current);
    setExpenseMonth(value as ExpenseMonthValue);
    setMonthModePage(1);
    setMonthModeLoading(false);
    setMonthModeError(null);
  };

  // Any OTHER filter change while a month is selected must also land back on
  // page 1 -- otherwise changing Status while on page 4 could request a page
  // that no longer exists for the new, narrower filtered population (§61).
  useEffect(() => {
    if (!isExactMonthMode) return;
    setMonthModePage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, searchTerm, sortBy, sortOrder, customFieldFilters]);

  const EXPENSE_INITIAL_FETCH_LIMIT = 150;
  const EXPENSE_FETCH_PAGE_SIZE = 1000;

  // Monotonic token: only the most recent fetchExpenses() may write to state,
  // so a slower request (or its async enrichment) can never revert the list.
  const fetchSeqRef = useRef(0);
  const { isMobile } = useViewportMode();

  const enrichExpenseList = async (
    baseExpenses: Expense[],
  ): Promise<Expense[]> => {
    const expenseIds = baseExpenses.map((e) => e.id);
    if (expenseIds.length === 0) return baseExpenses;

    let resubmittedIds = new Set<string>();
    let reviewerCorrectedIds = new Set<string>();
    let customByExpense: Record<string, Record<string, string>> = {};

    try {
      // All three enrichment queries are independent — run in parallel.
      const [fetchedResubmitted, fetchedCorrected, fetchedCustom] = await Promise.all([
        fetchResubmittedExpenseIds(supabase, expenseIds, organizationId),
        ExpenseService.getExpenseIdsWithReviewerCorrections(expenseIds, organizationId ?? null),
        organizationId
          ? fetchExpenseCustomFieldsMap(organizationId, expenseIds)
          : Promise.resolve({} as Record<string, Record<string, string>>),
      ]);
      resubmittedIds = fetchedResubmitted;
      reviewerCorrectedIds = fetchedCorrected;
      customByExpense = fetchedCustom;
    } catch (enrichError) {
      console.warn("Expense list enrichment failed (showing base rows):", enrichError);
    }

    return baseExpenses.map((expense) => ({
      ...expense,
      isResubmitted: resubmittedIds.has(expense.id),
      wasReviewerCorrected: reviewerCorrectedIds.has(expense.id),
      custom_fields: customByExpense[expense.id] ?? expense.custom_fields ?? {},
    }));
  };

  const fetchExpenses = async (options?: { loadAll?: boolean }) => {
    const fetchSeq = ++fetchSeqRef.current;
    const isStale = () => fetchSeq !== fetchSeqRef.current;
    try {
      if (!user?.id) return;

      const shouldLoadAll = options?.loadAll ?? allExpensesLoaded;
      const cached = readExpensesCache(user.id);
      const showFullScreenLoading = !cached && expenses.length === 0;
      setLoading(showFullScreenLoading);

      if (cached && !options?.loadAll) {
        setExpenses(cached.expenses);
        setTotalExpenseCount(cached.totalCount);
        setAllExpensesLoaded(cached.allLoaded);
        setLoading(false);
      }

      const { count, error: countError } = await supabase
        .from("expenses")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("deleted_at", null); // DOC-129: a trashed expense is in the Recycle Bin, not "My Expenses"
      if (countError) throw countError;
      const totalCount = count ?? 0;
      setTotalExpenseCount(totalCount);

      const allExpenses: Expense[] = [];
      const maxRows = shouldLoadAll
        ? totalCount
        : Math.min(EXPENSE_INITIAL_FETCH_LIMIT, totalCount);

      if (maxRows > 0) {
        let offset = 0;
        while (allExpenses.length < maxRows) {
          const pageEnd = Math.min(offset + EXPENSE_FETCH_PAGE_SIZE - 1, maxRows - 1);
          const { data, error } = await supabase
            .from("expenses")
            .select("*")
            .eq("user_id", user.id)
            .is("deleted_at", null) // DOC-129
            .order("updated_at", { ascending: false })
            .range(offset, pageEnd);

          if (error) throw error;
          const page = (data || []) as Expense[];
          allExpenses.push(...page);
          if (page.length < pageEnd - offset + 1) break;
          offset += EXPENSE_FETCH_PAGE_SIZE;
        }
      }

      const baseList = allExpenses.map((e) => ({
        ...e,
        isResubmitted: false,
        wasReviewerCorrected: false,
      }));
      if (isStale()) return;
      setExpenses(baseList);
      setAllExpensesLoaded(shouldLoadAll && allExpenses.length >= totalCount);
      setLoading(false);
      writeExpensesCache(user.id, {
        expenses: baseList,
        totalCount,
        allLoaded: shouldLoadAll && allExpenses.length >= totalCount,
      });

      if (baseList.length === 0) return;

      // Enrichment is optional metadata — never block the list from rendering.
      void (async () => {
        setEnrichingExpenses(true);
        try {
          const enriched = await enrichExpenseList(baseList);
          if (isStale()) return;
          setExpenses(enriched);
          writeExpensesCache(user.id, {
            expenses: enriched,
            totalCount,
            allLoaded: shouldLoadAll && allExpenses.length >= totalCount,
          });
        } catch (enrichError) {
          console.warn("Expense list enrichment failed (base rows kept):", enrichError);
        } finally {
          setEnrichingExpenses(false);
        }
      })();
    } catch (error) {
      console.error("Error fetching expenses:", error);
      if (expenses.length === 0) {
        toast({
          variant: "destructive",
          title: t("common:error"),
          description: "Could not load expenses. Try again or use Load all expenses.",
        });
      }
    } finally {
      setLoading(false);
      setLoadingAllExpenses(false);
    }
  };

  const handleLoadAllExpenses = async () => {
    setLoadingAllExpenses(true);
    await fetchExpenses({ loadAll: true });
  };

  // Drive load-all progress bar from existing loadingAllExpenses / enrichingExpenses flags
  useEffect(() => {
    const wasLoadingAll = prevLoadingAllRef.current;
    const wasEnriching = prevEnrichingRef.current;
    prevLoadingAllRef.current = loadingAllExpenses;
    prevEnrichingRef.current = enrichingExpenses;

    if (loadingAllExpenses && !wasLoadingAll) {
      startLoadAll(t("progress.loadAll"), { description: t("progress.loadingExpensesHint") });
    } else if (!loadingAllExpenses && wasLoadingAll && enrichingExpenses) {
      updateLoadAll(t("progress.enriching"), { description: t("progress.enrichingHint") });
    } else if (enrichingExpenses && !wasEnriching && !loadingAllExpenses) {
      updateLoadAll(t("progress.enriching"), { description: t("progress.enrichingHint") });
    } else if (!enrichingExpenses && wasEnriching) {
      completeLoadAll(
        t("progress.loadedCount", { loaded: expenses.length, total: Math.max(totalExpenseCount, expenses.length) }),
      );
    } else if (!loadingAllExpenses && wasLoadingAll && !enrichingExpenses) {
      completeLoadAll(
        t("progress.loadedCount", { loaded: expenses.length, total: Math.max(totalExpenseCount, expenses.length) }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingAllExpenses, enrichingExpenses]);

  const filterAndSortExpenses = () => {
    let filtered = [...expenses];

    // Apply search filter
    if (searchTerm) {
      filtered = filtered.filter((expense) =>
        expenseRowMatchesSearch(
          {
            ...expense,
            transaction_number: (expense as { transaction_number?: string }).transaction_number,
          },
          searchTerm,
        ),
      );
    }

    // Apply status filter
    if (statusFilter !== "all") {
      filtered = filtered.filter(expense => expense.status === statusFilter);
    }

    filtered = filtered.filter((expense) =>
      matchesCustomFieldFilters(expense.custom_fields, customFieldFilters),
    );

    // Apply sorting
    filtered.sort((a, b) => {
      let aValue, bValue;
      
      switch (sortBy) {
        case "title":
          aValue = a.title.toLowerCase();
          bValue = b.title.toLowerCase();
          break;
        case "destination":
          aValue = a.destination.toLowerCase();
          bValue = b.destination.toLowerCase();
          break;
        case "total_amount":
          aValue = a.total_amount;
          bValue = b.total_amount;
          break;
        case "trip_start":
          aValue = (parseLocalDate(a.trip_start) ?? new Date(a.trip_start)).getTime();
          bValue = (parseLocalDate(b.trip_start) ?? new Date(b.trip_start)).getTime();
          break;
        case "created_at":
        default:
          aValue = new Date(a.created_at).getTime();
          bValue = new Date(b.created_at).getTime();
          break;
      }

      if (sortOrder === "asc") {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    setFilteredExpenses(filtered);
  };

  // Helper function to escape CSV values
  const escapeCSV = (value: any): string => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    // If value contains comma, quote, or newline, wrap in quotes and escape quotes
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const exportExpenses = () => {
    const csvContent = [
      ["Transaction #", "Title", "Destination", "Start Date", "End Date", "Amount (INR)", "Status", "Submitted On"],
      ...filteredExpenses.map(expense => [
        escapeCSV((expense as any).transaction_number || ''),
        escapeCSV(expense.title),
        escapeCSV(expense.destination),
        format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "yyyy-MM-dd"),
        format(parseLocalDate(expense.trip_end) ?? new Date(expense.trip_end), "yyyy-MM-dd"),
        Number(expense.total_amount).toFixed(2), // Raw number without formatting
        escapeCSV(expense.status),
        formatCreatedDateTime(expense.created_at)
      ])
    ].map(row => row.join(",")).join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `expenses-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleReturnMoney = async () => {
    if (!user || !userRole || userBalance === null) return;

    const amount = parseFloat(returnAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({
        variant: "destructive",
        title: "Invalid Amount",
        description: "Please enter a valid amount greater than 0",
      });
      return;
    }

    if (amount > userBalance) {
      toast({
        variant: "destructive",
        title: "Insufficient Balance",
        description: `You only have ${formatINR(userBalance)}. Cannot return ${formatINR(amount)}`,
      });
      return;
    }

    try {
      setReturningMoney(true);

      // Determine target role and find target user
      let targetRole: "cashier" | "admin" | null = null;
      let targetUserId: string | null = null;

      if (userRole === "engineer" || userRole === "employee") {
        targetRole = "cashier";

        const { data: requesterProfile, error: requesterProfileError } = await supabase
          .from("profiles")
          .select("assigned_cashier_id, reporting_engineer_id, organization_id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (requesterProfileError) throw requesterProfileError;

        const requesterOrgId = (requesterProfile as any)?.organization_id || null;
        let managerId: string | null =
          userRole === "employee"
            ? ((requesterProfile as any)?.reporting_engineer_id || null)
            : user.id;

        if (userRole === "employee" && !managerId) {
          throw new Error("You don't have a manager assigned. Please contact an administrator.");
        }

        const pickActiveCashier = async (candidateIds: string[]): Promise<string | null> => {
          if (!candidateIds.length) return null;
          let membershipQuery = supabase
            .from("organization_memberships")
            .select("user_id")
            .in("user_id", candidateIds)
            .eq("role", "cashier")
            .eq("is_active", true);

          if (requesterOrgId) {
            membershipQuery = membershipQuery.eq("organization_id", requesterOrgId);
          }

          const { data: memberships, error: membershipsError } = await membershipQuery;
          if (membershipsError) {
            console.error("Error validating cashier memberships:", membershipsError);
            return null;
          }
          return memberships?.[0]?.user_id || null;
        };

        // 1) Explicit profile assignment first -- but only trust it if that
        // cashier/admin is still an active member of the requester's
        // organization. assigned_cashier_id is NOT cleared when a cashier is
        // deactivated (confirmed by the read-only deactivation-impact
        // preflight in 20261009000000_user_lifecycle_reactivation_and_impact.sql,
        // which only *reports* orphaned assigned_cashier_id references, never
        // clears them), so a stale pointer here used to short-circuit the
        // entire resolution chain and hard-fail every return request for any
        // employee whose assigned cashier had since left/been deactivated or
        // moved orgs -- even though the robust fallbacks below (2-4) could
        // have found a valid active cashier.
        const assignedCashierId = (requesterProfile as any)?.assigned_cashier_id || null;
        if (assignedCashierId) {
          let assignedMembershipQuery = supabase
            .from("organization_memberships")
            .select("user_id")
            .eq("user_id", assignedCashierId)
            .in("role", ["cashier", "admin"])
            .eq("is_active", true);
          if (requesterOrgId) {
            assignedMembershipQuery = assignedMembershipQuery.eq("organization_id", requesterOrgId);
          }
          const { data: assignedMembership, error: assignedMembershipError } = await assignedMembershipQuery.maybeSingle();
          if (assignedMembershipError) {
            console.error("Error validating assigned cashier membership:", assignedMembershipError);
          } else if (assignedMembership?.user_id) {
            targetUserId = assignedMembership.user_id;
          }
          // else: stale/invalid assignment -- fall through to steps 2-4.
        }

        // 2) Existing RPC
        if (!targetUserId && managerId) {
          const { data: cashierUserId, error: cashierError } = await supabase
            .rpc("get_cashier_for_engineer", { engineer_user_id: managerId });

          if (cashierError) {
            console.warn("RPC get_cashier_for_engineer failed, using fallback lookup:", cashierError);
          } else if (cashierUserId) {
            targetUserId = await pickActiveCashier([cashierUserId]) || cashierUserId;
          }
        }

        // 3) Direct assignment fallback
        if (!targetUserId && managerId) {
          let directQuery = supabase
            .from("profiles")
            .select("user_id")
            .eq("cashier_assigned_engineer_id", managerId)
            .limit(10);

          if (requesterOrgId) {
            directQuery = directQuery.eq("organization_id", requesterOrgId);
          }

          const { data: directCashiers, error: directError } = await directQuery;
          if (!directError && directCashiers?.length) {
            targetUserId = await pickActiveCashier(directCashiers.map((c: any) => c.user_id));
          }
        }

        // 4) Location-based fallback
        if (!targetUserId && managerId) {
          const { data: managerLocation } = await supabase
            .from("engineer_locations")
            .select("location_id")
            .eq("engineer_id", managerId)
            .limit(1)
            .maybeSingle();

          const locationId = (managerLocation as any)?.location_id || null;
          if (locationId) {
            let locationQuery = supabase
              .from("profiles")
              .select("user_id")
              .eq("cashier_assigned_location_id", locationId)
              .limit(10);

            if (requesterOrgId) {
              locationQuery = locationQuery.eq("organization_id", requesterOrgId);
            }

            const { data: locationCashiers, error: locationError } = await locationQuery;
            if (!locationError && locationCashiers?.length) {
              targetUserId = await pickActiveCashier(locationCashiers.map((c: any) => c.user_id));
            }
          }
        }

        if (!targetUserId) {
          throw new Error("Could not find an active cashier assignment for your manager. Please contact an administrator.");
        }
      } else if (userRole === "cashier") {
        targetRole = "admin";

        // For cashier returning to admin, find an admin in the same active organization.
        const { data: cashierMembership, error: membershipError } = await supabase
          .from("organization_memberships")
          .select("organization_id")
          .eq("user_id", user.id)
          .eq("role", "cashier")
          .eq("is_active", true)
          .maybeSingle();

        if (membershipError) {
          console.error("Error finding cashier organization:", membershipError);
          throw new Error("Failed to identify cashier organization. Please contact an administrator.");
        }

        if (cashierMembership?.organization_id) {
          const { data: adminMemberships, error: adminMembershipsError } = await supabase
            .from("organization_memberships")
            .select("user_id")
            .eq("organization_id", cashierMembership.organization_id)
            .eq("role", "admin")
            .eq("is_active", true)
            .limit(1);

          if (adminMembershipsError) {
            console.error("Error finding org admin:", adminMembershipsError);
            throw new Error("Failed to find admin in your organization. Please contact an administrator.");
          }

          if (adminMemberships && adminMemberships.length > 0) {
            targetUserId = adminMemberships[0].user_id;
          }
        }

        // Backward-compatible fallback for older data models where membership data may be incomplete.
        if (!targetUserId) {
          const { data: targetRoles, error: rolesError } = await supabase
            .from("user_roles")
            .select("user_id")
            .eq("role", targetRole)
            .limit(1);

          if (rolesError) {
            console.error("Error finding target role fallback:", rolesError);
            if (rolesError.message?.includes("permission") || rolesError.message?.includes("policy")) {
              throw new Error(`Permission denied. Please ensure the database migration for return money feature has been applied.`);
            }
            throw rolesError;
          }

          if (targetRoles && targetRoles.length > 0) {
            targetUserId = targetRoles[0].user_id;
          }
        }

        if (!targetUserId) {
          throw new Error("No admin found in your organization. Please contact an administrator.");
        }
      }

      if (!targetRole || !targetUserId) {
        throw new Error("Invalid role for returning money or target user not found");
      }

      // For employees/engineers returning to cashier, create a return request (requires approval)
      if ((userRole === "engineer" || userRole === "employee") && targetRole === "cashier") {
        // Create a return request (requires cashier approval)
        const { MoneyReturnService } = await import("@/services/MoneyReturnService");
        await MoneyReturnService.createReturnRequest(user.id, targetUserId, amount, returnNote);

        // Refresh balance (request doesn't change balance yet)
        void refreshBalance();

        // Update local state
        setReturnAmount("");
        setReturnNote("");
        setReturnMoneyDialogOpen(false);

        toast({
          title: "Return Request Submitted",
          description: `Your return request of ${formatINR(amount)} has been sent to your cashier for approval. You will be notified once it's approved.`,
        });
        return;
      }

      // For cashiers returning to admin, process immediately (no approval
      // needed) via the atomic server RPC -- locks both profile rows,
      // resolves the caller from auth.uid() server-side, and writes
      // balance_ledger + cash_transfer_history in the same transaction as
      // the balance mutation. No browser balance arithmetic, no partial
      // failure.
      const { data: returnResult, error: returnError } = await (supabase.rpc as any)(
        "cashier_return_money_to_admin_v2",
        {
          p_admin_user_id: targetUserId,
          p_amount: amount,
          p_note: returnNote.trim() || null,
        },
      );

      if (returnError) throw returnError;

      // Update local state
      void refreshBalance();
      setReturnAmount("");
      setReturnNote("");
      setReturnMoneyDialogOpen(false);

      toast({
        title: "Money Returned Successfully",
        description: `Returned ${formatINR(amount)} to ${returnResult?.admin_name || targetRole}. Your new balance: ${formatINR(returnResult?.cashier_balance_after ?? userBalance - amount)}`,
      });
    } catch (error: any) {
      console.error("Error returning money:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to return money. Please try again.",
      });
    } finally {
      setReturningMoney(false);
    }
  };

  const handleDeleteExpense = async () => {
    if (!expenseToDelete || !user) return;

    // Defense in depth: the menu item is already hidden for anything but a
    // draft (canOwnerTrashExpenseStatus), but never trust client state alone
    // for a destructive action — trash_expense_v1 re-checks ownership,
    // organization membership and status itself, atomically. This no longer
    // permanently erases anything (DOC-129): it moves the expense to the
    // 30-day Recycle Bin, so a previously-submitted-and-withdrawn draft that
    // DOC-128's delete_draft_expense_v1 used to refuse outright can now be
    // deleted like any other draft — its audit history is preserved by the
    // soft delete itself, not by refusing the action.
    if (!canOwnerTrashExpenseStatus(expenseToDelete.status)) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Only draft expenses can be deleted. A submitted expense can be withdrawn instead.",
      });
      return;
    }

    try {
      setDeleting(true);

      await trashExpense(expenseToDelete.id);

      toast({
        title: "Expense Moved to Recycle Bin",
        description: `"${expenseToDelete.title}" can be restored for 30 days from the Recycle Bin tab.`,
      });

      // Refresh expenses list (removes it from the active view immediately)
      // and nudge the Recycle Bin tab to refetch next time it's opened.
      await fetchExpenses();
      setTrashRefreshToken((n) => n + 1);
      setDeleteDialogOpen(false);
      setExpenseToDelete(null);
    } catch (error: unknown) {
      console.error("Error moving expense to Recycle Bin:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete expense",
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleWithdrawExpense = async () => {
    if (!expenseToWithdraw || !user) return;

    if (!canOwnerWithdrawExpenseStatus(expenseToWithdraw.status)) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Only a submitted expense that has not yet been reviewed can be withdrawn.",
      });
      return;
    }

    try {
      setWithdrawing(true);

      await withdrawSubmittedExpense(expenseToWithdraw.id);

      toast({
        title: "Expense Withdrawn",
        description: `Expense "${expenseToWithdraw.title}" has been returned to Drafts. You can edit and resubmit it, or delete it.`,
      });

      // Refresh expenses list
      await fetchExpenses();
      setWithdrawDialogOpen(false);
      setExpenseToWithdraw(null);
    } catch (error: unknown) {
      console.error("Error withdrawing expense:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to withdraw expense",
      });
    } finally {
      setWithdrawing(false);
    }
  };

  if (isMobile) {
    return (
      <MobileExpenseListView
        filteredExpenses={filteredExpenses as MobileExpenseItem[]}
        loading={loading}
        enrichingExpenses={enrichingExpenses}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        totalExpenseCount={totalExpenseCount}
        allExpensesLoaded={allExpensesLoaded}
        onLoadAll={handleLoadAllExpenses}
        loadingAllExpenses={loadingAllExpenses}
        loadAllProgressStatus={loadAllProgress.status}
        loadAllProgressTitle={loadAllProgress.phase || undefined}
        loadAllProgressDescription={loadAllProgress.description}
        expenseMonth={expenseMonth}
        monthOptions={monthOptions}
        onExpenseMonthChange={handleExpenseMonthChange}
        monthModeTotal={monthModeTotal}
        monthModePage={monthModePage}
        monthModeTotalPages={monthModeTotalPages}
        monthModeLoading={monthModeLoading}
        monthModeError={monthModeError}
        onMonthPageChange={setMonthModePage}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("myExpenses")}</h1>
          <p className="text-muted-foreground">{t("pageDescription")}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {userRole === "admin" && (
            <Button
              variant="outline"
              onClick={exportExpenses}
              disabled={isExactMonthMode}
              title={
                isExactMonthMode
                  ? "Export is unavailable while an exact Month is selected (it would only export the current page, not the full month). Switch to All months to export."
                  : undefined
              }
            >
              <Download className="mr-2 h-4 w-4" />
              {t("exportCsv")}
            </Button>
          )}
          <SubmitExpenseActions />
          {(userRole === "engineer" || userRole === "employee" || userRole === "cashier") && (
            <Dialog open={returnMoneyDialogOpen} onOpenChange={setReturnMoneyDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Return Money
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Return Money</DialogTitle>
                  <DialogDescription>
                    {userRole === "cashier" 
                      ? "Return money to admin. The amount will be deducted from your balance and added to an admin's account."
                      : "Return money to cashier. The amount will be deducted from your balance and added to a cashier's account."}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="return-amount">Amount to Return (INR)</Label>
                    <Input
                      id="return-amount"
                      type="number"
                      min="0"
                      step="0.01"
                      value={returnAmount}
                      onChange={(e) => setReturnAmount(e.target.value)}
                      placeholder="0.00"
                    />
                    {userBalance !== null && (
                      <p className="text-sm text-muted-foreground">
                        Your current balance: <span className="font-semibold">{formatINR(userBalance)}</span>
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="return-note">Note (optional)</Label>
                    <Textarea
                      id="return-note"
                      value={returnNote}
                      onChange={(e) => setReturnNote(e.target.value)}
                      placeholder="Add reason or context for this return"
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setReturnMoneyDialogOpen(false);
                      setReturnAmount("");
                      setReturnNote("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button onClick={handleReturnMoney} disabled={returningMoney || !returnAmount}>
                    {returningMoney ? "Returning..." : "Return Money"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <Tabs value={expensesTab} onValueChange={(v) => setExpensesTab(v as "all" | "drafts" | "trash")} className="space-y-6">
        <TabsList>
          <TabsTrigger value="all">{t("expenses:allExpensesTab")}</TabsTrigger>
          <TabsTrigger value="drafts" className="gap-2">
            {t("expenses:savedDrafts.tabTitle")}
            {savedDraftsCount > 0 ? (
              <Badge variant="secondary" className="h-5 min-w-5 px-1.5 text-xs">
                {savedDraftsCount}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="trash" className="gap-2">
            Recycle Bin
            {trashedCount > 0 ? (
              <Badge variant="secondary" className="h-5 min-w-5 px-1.5 text-xs">
                {trashedCount}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="drafts" className="mt-0">
          <ExpenseSavedDraftsPanel
            userId={user?.id}
            organizationId={organizationId}
            knownExpenseIds={new Set(expenses.map((e) => e.id))}
            onCountChange={setSavedDraftsCount}
          />
        </TabsContent>

        <TabsContent value="trash" className="mt-0">
          <ExpenseRecycleBinPanel
            organizationId={organizationId}
            onCountChange={setTrashedCount}
            refreshToken={trashRefreshToken}
          />
        </TabsContent>

        <TabsContent value="all" className="mt-0 space-y-6">
      {/* Search and Filter Controls */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search title, destination, project, amount…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="verified">Verified</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trip_start">Date of Expense</SelectItem>
                  <SelectItem value="created_at">Date Created</SelectItem>
                  <SelectItem value="title">Title</SelectItem>
                  <SelectItem value="destination">Destination</SelectItem>
                  <SelectItem value="total_amount">Amount</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
              >
                {sortOrder === "asc" ? "↑" : "↓"}
              </Button>
              {/* Month — exact calendar month on trip_start; applies immediately. */}
              <Select value={expenseMonth} onValueChange={handleExpenseMonthChange}>
                <SelectTrigger className="w-40" aria-label="Month">
                  <SelectValue placeholder="Month" />
                </SelectTrigger>
                <SelectContent>
                  {monthOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <ExpenseCustomFieldFilters
            fields={filterableCustomFields}
            values={customFieldFilters}
            onChange={setCustomFieldFilters}
            className="mt-4"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Expenses</CardTitle>
          <CardDescription>View and manage your expense claims</CardDescription>
        </CardHeader>
        <CardContent>
          {isExactMonthMode && monthModeLoading && filteredExpenses.length === 0 ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <p className="text-muted-foreground">{t("common:loading")}</p>
            </div>
          ) : isExactMonthMode && monthModeError ? (
            <div className="space-y-3">
              <p className="text-destructive">{monthModeError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fetchMyExpensesMonthPage(monthModePage)}
              >
                Retry
              </Button>
            </div>
          ) : isExactMonthMode && filteredExpenses.length === 0 ? (
            <p className="text-muted-foreground">
              No expenses found for {formatExpenseMonthLabel(expenseMonth)}.
            </p>
          ) : loading ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <p className="text-muted-foreground">{t("common:loading")}</p>
            </div>
          ) : expenses.length === 0 && !loading && totalExpenseCount > 0 ? (
            <div className="space-y-3">
              <p className="text-muted-foreground">
                Expenses exist but could not all be loaded. Try loading them explicitly.
              </p>
              <AsyncOperationProgress
                status={loadAllProgress.status}
                title={loadAllProgress.phase}
                description={loadAllProgress.description}
                showSuccess={loadAllProgress.status === "success"}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleLoadAllExpenses}
                disabled={loadingAllExpenses}
              >
                {loadingAllExpenses ? t("progress.loadAll") : t("loadAll")}
              </Button>
            </div>
          ) : expenses.length === 0 ? (
            <p className="text-muted-foreground">
              {t("noExpenses")}. {t("noExpensesDescription")}
            </p>
          ) : filteredExpenses.length === 0 ? (
            <p className="text-muted-foreground">{t("noFilterMatch")}</p>
          ) : (
            <>
              {isExactMonthMode ? (
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm text-muted-foreground">
                  <span>
                    {monthModeTotal.toLocaleString()} expense{monthModeTotal === 1 ? "" : "s"} in{" "}
                    {formatExpenseMonthLabel(expenseMonth)}
                    {monthModeLoading ? " (updating…)" : ""}
                  </span>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm text-muted-foreground">
                    <span>
                      Showing {filteredExpenses.length} of {expenses.length} loaded expenses
                      {enrichingExpenses ? " (updating details…)" : ""}
                    </span>
                    <span>
                      Loaded {expenses.length.toLocaleString()} of{" "}
                      {Math.max(totalExpenseCount, expenses.length).toLocaleString()} total
                    </span>
                  </div>
                  {(loadAllProgress.status !== "idle" || (!allExpensesLoaded && expenses.length < Math.max(totalExpenseCount, expenses.length))) && (
                    <div className="mb-4 space-y-2">
                      <AsyncOperationProgress
                        status={loadAllProgress.status}
                        title={loadAllProgress.phase}
                        description={loadAllProgress.description}
                        showSuccess={loadAllProgress.status === "success"}
                      />
                      {!allExpensesLoaded && expenses.length < Math.max(totalExpenseCount, expenses.length) && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleLoadAllExpenses}
                          disabled={loadingAllExpenses}
                        >
                          {loadingAllExpenses ? t("progress.loadAll") : t("loadAll")}
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <div className="inline-block min-w-full align-middle">
                  <Table className="min-w-full">
                  <TableHeader>
                    <TableRow>
                        <TableHead className="min-w-[80px] whitespace-nowrap">Txn #</TableHead>
                        <TableHead className="min-w-[140px] sm:min-w-[140px]">Title / Destination</TableHead>
                        <TableHead className="w-[140px] max-w-[140px] hidden sm:table-cell">Destination</TableHead>
                        <TableHead className="min-w-[90px] whitespace-nowrap">Amount</TableHead>
                        <TableHead className="min-w-[100px] hidden sm:table-cell">Status</TableHead>
                        <TableHead className="min-w-[100px] hidden sm:table-cell">Expense Date</TableHead>
                        <TableHead className="min-w-[140px] hidden md:table-cell">{t("colDateCreated")}</TableHead>
                        <TableHead className="text-right min-w-[120px]">Status / Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                <TableBody>
                  {filteredExpenses.map((expense) => (
                  <TableRow key={expense.id}>
                    <TableCell className="text-xs sm:text-sm font-mono font-semibold text-blue-600 whitespace-nowrap">
                      {(expense as any).transaction_number || '-'}
                    </TableCell>
                    <TableCell className="text-xs sm:text-sm">
                      <div className="font-medium">{expense.title}</div>
                      <div className="text-xs text-muted-foreground sm:hidden mt-1">{expense.destination}</div>
                      <div className="text-xs text-muted-foreground sm:hidden mt-1">
                        {format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}
                      </div>
                      <div className="text-xs text-muted-foreground sm:hidden mt-1">
                        {t("dateCreated")}: {formatCreatedDateTime(expense.created_at)}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs sm:text-sm truncate hidden sm:table-cell max-w-[140px]" title={expense.destination}>{expense.destination}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs sm:text-sm font-medium">{formatINR(expense.total_amount)}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {(expense as any).isResubmitted && (expense.status === "submitted" || expense.status === "edited") ? (
                        <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                          Resubmitted
                        </Badge>
                      ) : (
                        <ExpenseStatusWithCorrectionBadge
                          status={expense.status}
                          wasReviewerCorrected={expense.wasReviewerCorrected}
                          viewerContext="owner"
                        />
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs sm:text-sm hidden sm:table-cell">
                      {format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs sm:text-sm hidden md:table-cell">
                      {formatCreatedDateTime(expense.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col sm:flex-row items-end gap-2 sm:gap-0">
                        <div className="sm:hidden">
                          {(expense as any).isResubmitted && (expense.status === "submitted" || expense.status === "edited") ? (
                            <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                              Resubmitted
                            </Badge>
                          ) : (
                            <ExpenseStatusWithCorrectionBadge
                              status={expense.status}
                              wasReviewerCorrected={expense.wasReviewerCorrected}
                              viewerContext="owner"
                            />
                          )}
                        </div>
                        <div className="flex justify-end shrink-0 gap-1">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-8 px-2 text-xs font-normal whitespace-nowrap"
                            onClick={() => navigate(`/expenses/${expense.id}`)}
                          >
                            View
                          </Button>
                          {canOwnerEditExpenseStatus(expense.status) && (userRole !== "cashier" || (userRole === "cashier" && allowCashierExpenseSubmission === true && expense.user_id === user?.id)) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0">
                                  <MoreVertical className="h-4 w-4" />
                                  <span className="sr-only">More actions</span>
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => navigate(`/expenses/${expense.id}/edit`)}>
                                  <Edit className="mr-2 h-4 w-4" />
                                  {expense.status === "rejected" ? "Edit & Resubmit" : "Edit"}
                                </DropdownMenuItem>
                                {canOwnerWithdrawExpenseStatus(expense.status) && (
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setExpenseToWithdraw(expense);
                                      setWithdrawDialogOpen(true);
                                    }}
                                  >
                                    <Undo2 className="mr-2 h-4 w-4" />
                                    Withdraw
                                  </DropdownMenuItem>
                                )}
                                {canOwnerTrashExpenseStatus(expense.status) && (
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setExpenseToDelete(expense);
                                      setDeleteDialogOpen(true);
                                    }}
                                    className="text-red-600 focus:text-red-600"
                                  >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                </TableBody>
              </Table>
              </div>
              </div>
              {isExactMonthMode && monthModeTotalPages > 1 && (
                <div className="mt-4 flex items-center justify-between text-sm">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMonthModePage((p) => Math.max(1, p - 1))}
                    disabled={monthModePage <= 1 || monthModeLoading}
                  >
                    Previous
                  </Button>
                  <span className="text-muted-foreground">
                    Page {monthModePage} of {monthModeTotalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMonthModePage((p) => Math.min(monthModeTotalPages, p + 1))}
                    disabled={monthModePage >= monthModeTotalPages || monthModeLoading}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>

      {/* Delete Expense Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move to Recycle Bin?</AlertDialogTitle>
            <AlertDialogDescription>
              Move the expense "{expenseToDelete?.title}" to the Recycle Bin?
              <br /><br />
              You can restore it for 30 days from the Recycle Bin tab. Items are automatically deleted for good after 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setDeleteDialogOpen(false);
              setExpenseToDelete(null);
            }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteExpense}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleting}
            >
              {deleting ? "Moving..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Withdraw Expense Confirmation Dialog */}
      <AlertDialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw Expense</AlertDialogTitle>
            <AlertDialogDescription>
              Withdraw the expense "{expenseToWithdraw?.title}"? It has not been reviewed yet.
              <br /><br />
              It will move back to Drafts — nothing is deleted, and your balance is not affected. You can edit and resubmit it whenever you're ready, or delete it from Drafts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setWithdrawDialogOpen(false);
              setExpenseToWithdraw(null);
            }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleWithdrawExpense}
              disabled={withdrawing}
            >
              {withdrawing ? "Withdrawing..." : "Withdraw"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
