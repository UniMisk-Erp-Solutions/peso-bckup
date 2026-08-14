/**
 * Review Expenses, backed by the proven server queue (DOC-080 §2).
 *
 * Visually this is the existing page: same heading, same four KPI cards, same
 * Assigned Expenses card, same filter row, same custom-fields section, same
 * table and pagination styling. Nothing about the debug page appears here — no
 * contract status, no schema revision, no diagnostics, no timings.
 *
 * What changed is entirely underneath. Every row, count, filter and page comes
 * from one RPC per interaction instead of the V1 pipeline that accumulated
 * eleven overlapping mechanisms and still returned ~1,512 of ~6,088 rows.
 *
 * The load-bearing behaviour: typing issues zero requests, and the employee
 * filter travels as an immutable user_id that never matches a transaction
 * number. That separation is why searching 6174 returns employee 6174's 24
 * expenses instead of transaction 06174 owned by employee 6557.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { Receipt, X } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { getDateLocale } from "@/lib/formatLocale";
import { formatINR } from "@/lib/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED,
  REVIEW_EXPENSES_SERVER_QUEUE_ENABLED,
} from "@/config/reviewQueueServerFeature";
import { useReviewQueueCapabilities } from "@/features/reviewQueueServer/hooks/useReviewQueueCapabilities";
import { useReviewQueueFilterOptions } from "@/features/reviewQueueServer/hooks/useReviewQueueFilterOptions";
import { useReviewQueuePage } from "@/features/reviewQueueServer/hooks/useReviewQueuePage";
import { useReviewExpenseDetail } from "@/features/reviewQueueServer/hooks/useReviewExpenseDetail";
import {
  buildQueryShapeKey,
  timePeriodToRange,
  useReviewQueueFilters,
} from "@/features/reviewQueueServer/hooks/useReviewQueueFilters";
import { useCursorHistory } from "@/features/reviewQueueServer/hooks/useCursorHistory";
import { fetchReviewQueuePageAnchor } from "@/features/reviewQueueServer/api";
import {
  useSingleBarSearch,
  type SearchResolution,
} from "@/features/reviewQueueServer/hooks/useSingleBarSearch";
import { useReviewExpenseActions } from "@/features/reviewActions/hooks/useReviewExpenseActions";
import { useBulkReviewActions } from "@/features/reviewActions/hooks/useBulkReviewActions";
import type { ActionableExpense } from "@/features/reviewActions/types";
import { ReviewBulkActions } from "./ReviewBulkActions";
import { isSelectableForBulk, summarizeBulkApprove } from "./bulkEligibility";
import { ReviewCustomFieldFilters } from "./ReviewCustomFieldFilters";
import { ReviewEmployeeResultsPopover } from "./ReviewEmployeeResultsPopover";
import { ReviewErrorState } from "./ReviewErrorState";
import { reviewErrorKind } from "./errorKind";
import { ReviewExpenseDetail } from "./ReviewExpenseDetail";
import { ReviewCorrectionDialog, type CorrectionSeed } from "./ReviewCorrectionDialog";
import { ReviewExpensesMobileList } from "./ReviewExpensesMobileList";
import { ReviewExpensesTable } from "./ReviewExpensesTable";
import { ReviewFilters } from "./ReviewFilters";
import { ReviewPagination } from "./ReviewPagination";
import { ReviewSearchBar } from "./ReviewSearchBar";
import { ReviewStatsCards } from "./ReviewStatsCards";
import { hasContentFilter, type SummaryContext } from "./summarySource";
import {
  APP_MAIN_SCROLL_ID,
  buildReviewQueueReturnSnapshot,
  clearReturnSnapshotFromSession,
  readCurrentScrollPositions,
  readReturnSnapshotFromSession,
  readSnapshotFromLocationState,
  REVIEW_RETURN_STATE_KEY,
  saveReturnSnapshotToSession,
  type ReviewQueueReturnSnapshot,
} from "./reviewQueueReturnState";
import type {
  ReviewQueueItem,
  ReviewQueueSort,
  ReviewTimePeriod,
} from "@/features/reviewQueueServer/types";

const ALL = "all";

export function ReviewExpensesServerPage({ onUseLegacy }: { onUseLegacy?: () => void }) {
  const { t, i18n } = useTranslation(["admin", "expenses", "common"]);
  const { user, organizationId, userRole, organizationFeatureFlags } = useAuth();
  const isMobile = useIsMobile();
  const moneyLocale = getDateLocale(i18n.language);

  const navigate = useNavigate();
  const location = useLocation();
  /**
   * POP means the browser's own history moved (Back/Forward). It is the ONLY case where
   * the sessionStorage fallback may be consulted: a deliberate PUSH to /review from the
   * sidebar is the reviewer asking for a fresh queue, and reviving a batch-return
   * snapshot there would silently reapply filters they did not ask for.
   */
  const navigationType = useNavigationType();

  // Same derivation as main — nested conditional fields are only offered in the
  // correction editor when the organization has both flags on.
  const allowNestedConditional =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields] === true &&
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields] ===
      true;

  const [detailId, setDetailId] = useState<string | null>(null);
  /** Set when the reviewer opens the correction editor for the open expense. */
  const [correctionSeed, setCorrectionSeed] = useState<CorrectionSeed | null>(null);
  /** Optional admin comment. Survives a failed action; cleared on success. */
  const [detailComment, setDetailComment] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** Names the work in flight so the progress bar can say what it is doing. */
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const tableTopRef = useRef<HTMLDivElement | null>(null);
  /** Guards against a second jump being queued by a double click. */
  const jumpInFlight = useRef(false);

  /**
   * Return-from-batch restoration (DOC-080 §12).
   *
   * An explicit phase, not a pile of booleans, because the ordering constraint is real:
   * the queue query must not fire until the restored query shape is in place, or the
   * reviewer sees a flash of unfiltered page-1 rows and global KPIs — and that first
   * request is wasted work whose response can also land after the restored one.
   *
   *   hydrating             search + filters being applied; queue disabled
   *   resolving-page        restored shape is live; resolving the page cursor
   *   loading-restored-page queue re-enabled, fetching the right page
   *   complete / failed     normal operation resumes
   */
  type RestorePhase =
    | "none"
    | "hydrating"
    | "resolving-page"
    | "loading-restored-page"
    | "complete"
    | "failed";

  /**
   * Read once, synchronously, during the first render. An effect would be too late: the
   * queue query would already have been enabled with blank filters and fired.
   */
  const [pendingSnapshot] = useState<ReviewQueueReturnSnapshot | null>(() => {
    const context = { organizationId, reviewerUserId: user?.id ?? null };
    // Router state is authoritative and always qualifies — it can only exist because the
    // batch page put it there on this navigation.
    const fromRouter = readSnapshotFromLocationState(location.state, context);
    if (fromRouter) return fromRouter;
    // The fallback exists solely for browser Back, which returns to a /review history
    // entry whose state predates the batch.
    if (navigationType !== "POP") return null;
    return readReturnSnapshotFromSession(context);
  });

  const [restorePhase, setRestorePhase] = useState<RestorePhase>(() =>
    pendingSnapshot ? "hydrating" : "none",
  );
  const restoring =
    restorePhase === "hydrating" ||
    restorePhase === "resolving-page" ||
    restorePhase === "loading-restored-page";

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const capabilities = useReviewQueueCapabilities(
    "review",
    REVIEW_EXPENSES_SERVER_QUEUE_ENABLED,
  );

  // Any change to what is being queried resets paging AND row selection — a
  // cursor from the previous filter set points into a different sequence, and
  // rows selected on the old page are no longer on screen.
  const f = useReviewQueueFilters({ onQueryShapeChange: clearSelection });

  /**
   * ONE deliberate transition per search resolution.
   *
   * Previously this was `onResolved: clearSelection`, which cleared row
   * checkboxes and nothing else. So selecting employee 6174 while a "Level 2
   * Verified" status filter was active silently asked for the INTERSECTION - an
   * employee the search had just reported 24 expenses for showed an empty table,
   * with the cards still reading organization-wide totals.
   *
   * Selecting an employee is a new question, not a refinement of the old one, so
   * it resets every content filter. Sort and page size are preferences about how
   * results are shown, not about which results, so they survive.
   *
   * This runs on RESOLUTION - a discrete event - not from an effect watching
   * state, so it cannot fight the reviewer by re-clearing filters they apply
   * afterwards.
   */
  const onSearchResolved = useCallback(
    (resolution: SearchResolution) => {
      clearSelection();
      setDetailId(null);
      setCorrectionSeed(null);
      if (resolution.kind === "employee") {
        f.resetContentFilters();
      }
    },
    // f.resetContentFilters and clearSelection are both stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearSelection],
  );

  const search = useSingleBarSearch({
    organizationId,
    onResolved: onSearchResolved,
  });

  const filterOptions = useReviewQueueFilterOptions({
    scope: "review",
    organizationId,
    userId: user?.id ?? null,
    enabled: REVIEW_EXPENSES_SERVER_QUEUE_ENABLED && capabilities.isReady,
  });

  const range = useMemo(
    () => timePeriodToRange(f.filters.timePeriod, new Date()),
    [f.filters.timePeriod],
  );

  /** Everything that defines the filtered ordering. Cursors live and die by it. */
  const queryShape = useMemo(
    () => ({
      organizationId,
      employeeUserId: search.selectedEmployee?.user_id ?? null,
      generalSearch: search.generalSearch,
      statuses: f.filters.statuses,
      categories: f.filters.categories,
      dateFrom: range.from,
      dateTo: range.to,
      actionableOnly: f.filters.actionableOnly,
      customFilters: f.filters.customFilters,
      sort: f.filters.sort,
      pageSize: f.filters.pageSize,
    }),
    [organizationId, search.selectedEmployee?.user_id, search.generalSearch, f.filters, range],
  );

  const pager = useCursorHistory(buildQueryShapeKey(queryShape));

  const queue = useReviewQueuePage("review", {
    ...queryShape,
    userId: user?.id ?? null,
    cursor: pager.cursor,
    enabled:
      REVIEW_EXPENSES_SERVER_QUEUE_ENABLED &&
      capabilities.isReady &&
      // Held back until the restored shape and page are settled. Without this the first
      // render fires an unfiltered page-1 request whose rows and KPIs briefly replace the
      // context the reviewer is being returned to.
      restorePhase !== "hydrating" &&
      restorePhase !== "resolving-page",
  });

  // A comment typed against one expense must not follow the reviewer to the next.
  useEffect(() => {
    setDetailComment("");
  }, [detailId]);

  const detail = useReviewExpenseDetail({
    scope: "review",
    organizationId,
    expenseId: detailId,
    enabled: REVIEW_EXPENSES_SERVER_QUEUE_ENABLED && capabilities.isReady,
  });

  // ── Return-from-batch restoration ────────────────────────────────────────
  //
  // Three ordered steps. Each waits for the previous one's state to be committed,
  // which is why they are separate effects rather than one async function: the
  // restored query shape only exists on the render AFTER hydration is applied.

  /** 1 — apply search and filters, each as a single atomic state update. */
  useEffect(() => {
    if (restorePhase !== "hydrating" || !pendingSnapshot) return;
    search.restoreSearch(pendingSnapshot.search);
    f.restoreFilters(pendingSnapshot.filters);
    setRestorePhase("resolving-page");
    // search.restoreSearch and f.restoreFilters are stable; re-running on every render
    // of a changing `search`/`f` object would re-hydrate over the reviewer's own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restorePhase, pendingSnapshot]);

  /**
   * 2 — resolve the CURRENT cursor for the saved logical page.
   *
   * The saved cursor is deliberately not carried in the snapshot and is never reused.
   * Reviewing a batch can change status, actionability and filtered totals, so the row
   * ordering it addressed may no longer exist. Asking the server for "where does page N
   * of THIS query start now" is the only way to land on the right slice — and the RPC
   * clamps `target_page` itself, so a shrunken dataset lands on the last real page rather
   * than an empty one or a silent reset to page 1.
   */
  useEffect(() => {
    if (restorePhase !== "resolving-page" || !pendingSnapshot) return;

    const target = pendingSnapshot.pageNumber;
    if (target <= 1) {
      setRestorePhase("loading-restored-page");
      return;
    }

    /**
     * Wait for the capability answer instead of assuming its absence means "no anchor".
     *
     * Restoration begins on mount, and on a browser-Back the capabilities query is still
     * in flight at that moment. Reading `page_anchor` as undefined and skipping the anchor
     * would silently drop the reviewer on page 1 of the restored shape — the page number
     * being precisely what this feature exists to restore. Staying in `resolving-page` is
     * safe: the queue is disabled here, so nothing wrong is rendered while we wait, and
     * this effect re-runs when the answer lands.
     */
    if (!capabilities.capabilities && !capabilities.error) return;

    const anchorAvailable = capabilities.capabilities?.functions.page_anchor === true;
    if (!organizationId || !anchorAvailable) {
      // No way to resolve a cursor for page N. Page 1 OF THE RESTORED SHAPE is still the
      // better answer than a blank page — search and filters are preserved regardless.
      setRestorePhase("loading-restored-page");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const anchor = await fetchReviewQueuePageAnchor({
          organizationId,
          targetPage: target,
          pageSize: queryShape.pageSize,
          sort: queryShape.sort,
          employeeUserId: queryShape.employeeUserId,
          generalSearch: queryShape.generalSearch,
          statuses: queryShape.statuses.length ? queryShape.statuses : null,
          categories: queryShape.categories.length ? queryShape.categories : null,
          dateFrom: queryShape.dateFrom,
          dateTo: queryShape.dateTo,
          actionableOnly: queryShape.actionableOnly,
          customFilters: queryShape.customFilters,
        });
        if (cancelled) return;
        pager.goToAnchoredPage(anchor.target_page, anchor.cursor);
      } catch {
        // Fall through on page 1 of the restored shape rather than blocking the return.
      } finally {
        if (!cancelled) setRestorePhase("loading-restored-page");
      }
    })();

    return () => {
      cancelled = true;
    };
    // queryShape is read, not depended on: it is already the restored shape by this
    // phase, and depending on it would restart the anchor request on every filter edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restorePhase, pendingSnapshot, organizationId, capabilities.capabilities, capabilities.error]);

  /**
   * 3 — restore scroll once the rows actually exist, then consume the snapshot.
   *
   * `ScrollToTop` resets both the window and `#app-main-scroll` on every pathname change,
   * so this must run after it. Two `requestAnimationFrame` hops is the honest way to wait
   * for "React committed AND the browser laid the table out" — a timeout would be a guess
   * that is simultaneously too long on a fast machine and too short on a slow one.
   */
  useEffect(() => {
    if (restorePhase !== "loading-restored-page") return;
    if (queue.isFetching) return;
    // An error ends the restoration too — otherwise the phase would pin the progress bar
    // on screen forever while the error state is rendered underneath it.
    if (!queue.page && !queue.error) return;

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const target = pendingSnapshot?.scroll;
        if (target && queue.page) {
          const main = document.getElementById(APP_MAIN_SCROLL_ID);
          if (main) {
            const max = Math.max(0, main.scrollHeight - main.clientHeight);
            // If the reviewed rows are gone the page may be far shorter than it was;
            // clamping lands at the bottom, and the table top is a more honest
            // destination than an unrelated section further down.
            main.scrollTo({ top: Math.min(target.appMainY, max), behavior: "auto" });
          }
          const windowMax = Math.max(
            0,
            document.documentElement.scrollHeight - window.innerHeight,
          );
          window.scrollTo({ top: Math.min(target.windowY, windowMax), behavior: "auto" });
        }
        clearReturnSnapshotFromSession(organizationId, user?.id ?? null);
        setRestorePhase("complete");
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [restorePhase, queue.isFetching, queue.page, queue.error, pendingSnapshot, organizationId, user?.id]);

  /**
   * Keep the working context recoverable across a browser REFRESH, not just a batch trip.
   *
   * Reloading `/review` previously threw away the search, every filter and the page — the
   * same loss as the batch round trip, from a different cause: a reload starts a fresh
   * document, so nothing in React state or router state survives it. The snapshot is
   * therefore written whenever the query changes rather than only on the way to a batch.
   *
   * A reload is a POP, so the existing restoration rule picks it up unchanged; a deliberate
   * PUSH to /review from the sidebar still ignores it and gives a clean queue.
   *
   * Writes are skipped during restoration, or the half-restored state would overwrite the
   * snapshot being restored from.
   */
  useEffect(() => {
    if (restoring || !organizationId || !user?.id) return;
    const snapshot = buildReviewQueueReturnSnapshot({
      organizationId,
      reviewerUserId: user.id,
      search: {
        draft: search.draft,
        submitted: search.submitted,
        selectedEmployee: search.selectedEmployee,
        generalSearch: search.generalSearch,
      },
      filters: f.filters,
      pageNumber: pager.pageNumber,
      scroll: readCurrentScrollPositions(),
    });
    if (snapshot) saveReturnSnapshotToSession(snapshot);
  }, [
    restoring,
    organizationId,
    user?.id,
    search.draft,
    search.submitted,
    search.selectedEmployee,
    search.generalSearch,
    f.filters,
    pager.pageNumber,
  ]);

  /**
   * One control that puts the queue back to its default view AND forgets the persisted
   * context — otherwise the next refresh would helpfully restore the very search the
   * reviewer just cleared.
   */
  const clearSearchAndFilters = useCallback(() => {
    search.clearAll();
    f.resetFilters();
    clearSelection();
    setDetailId(null);
    setCorrectionSeed(null);
    clearReturnSnapshotFromSession(organizationId, user?.id ?? null);
    // search.clearAll and f.resetFilters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSelection, organizationId, user?.id]);

  /** True when there is anything for the clear control to act on. */
  const hasActiveQuery =
    Boolean(search.selectedEmployee) ||
    Boolean(search.generalSearch) ||
    Boolean(search.submitted) ||
    search.draft.trim().length > 0 ||
    f.activeFilterCount > 0;

  /**
   * THE row-activation rule, ported from main's `navigateToBatchReview`.
   *
   * A batch line is not the batch. Opening one in the singular dialog invites a
   * reviewer to approve a single line and leave the rest of the batch behind, so
   * a batch row navigates to the batch-review page and never sets `detailId` —
   * which means the singular detail RPC is never issued and no modal can flash
   * before the route changes.
   *
   * The queue state travels in `location.state` so returning from batch review
   * can restore the search, filters, sort and page rather than resetting to an
   * unfiltered page 1.
   */
  const openExpense = useCallback(
    (item: ReviewQueueItem) => {
      if (item.batch_id) {
        /**
         * Built and validated through the same parser the return path uses, so a field
         * that would be rejected on the way back fails here instead — while the offending
         * value is still in scope.
         *
         * The full selected-employee object travels, not just its user_id: restoring must
         * never re-run the employee lookup to rebuild an identity, because a display-name
         * search can resolve to a different person or to nothing at all.
         */
        const snapshot =
          organizationId && user?.id
            ? buildReviewQueueReturnSnapshot({
                organizationId,
                reviewerUserId: user.id,
                search: {
                  draft: search.draft,
                  submitted: search.submitted,
                  selectedEmployee: search.selectedEmployee,
                  generalSearch: search.generalSearch,
                },
                filters: f.filters,
                pageNumber: pager.pageNumber,
                scroll: readCurrentScrollPositions(),
              })
            : null;

        // Both channels, for two different Back buttons: router state serves the app's own
        // control, sessionStorage serves the browser's, which returns to a /review history
        // entry written before the batch was ever opened. Query state only — no rows.
        if (snapshot) saveReturnSnapshotToSession(snapshot);

        navigate(
          `/expenses/batch/${item.batch_id}/review?from=review&expense=${item.id}`,
          {
            state: {
              from: "review",
              ...(snapshot ? { [REVIEW_RETURN_STATE_KEY]: snapshot } : {}),
            },
          },
        );
        return;
      }
      setDetailId(item.id);
    },
    [
      navigate,
      organizationId,
      user?.id,
      search.draft,
      search.submitted,
      search.selectedEmployee,
      search.generalSearch,
      f.filters,
      pager,
    ],
  );

  const toggleRow = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = (checked: boolean) =>
    setSelectedIds(
      checked ? new Set(items.filter(isSelectableForBulk).map((e) => e.id)) : new Set(),
    );

  const isHierarchyReviewer = userRole === "team_leader" || userRole === "executive";

  const page = queue.page;
  const items = queue.items;

  /** True when anything narrows the population the table pages through. */
  const filtered = hasContentFilter({
    employeeUserId: search.selectedEmployee?.user_id ?? null,
    generalSearch: search.generalSearch,
    statuses: f.filters.statuses,
    categories: f.filters.categories,
    timePeriod: f.filters.timePeriod,
    actionableOnly: f.filters.actionableOnly,
    customFilterCount: f.filters.customFilters.length,
  });

  const summaryContext: SummaryContext = search.selectedEmployee
    ? {
        kind: "employee",
        name: search.selectedEmployee.employee_name,
        employeeId: search.selectedEmployee.employee_id,
      }
    : filtered
      ? { kind: "search" }
      : { kind: "global" };

  /**
   * A selected employee with no other filter must show rows: the employee search
   * already reported how many are visible. Zero here is a contract failure, not
   * an empty employee, and saying "this employee has no expenses" would be a
   * false statement about Production data.
   */
  const employeeContractBreach =
    Boolean(search.selectedEmployee) &&
    !f.activeFilterCount &&
    !search.generalSearch &&
    (search.selectedEmployee?.visible_expense_count ?? 0) > 0 &&
    page !== null &&
    page.filtered_total === 0;

  useEffect(() => {
    if (!import.meta.env.DEV || !employeeContractBreach) return;
    // Structured and safe: ids and booleans only, never an email or a token.
    console.warn("[review] employee filter returned zero rows despite a nonzero visible count", {
      employeeUserId: search.selectedEmployee?.user_id ?? null,
      visibleExpenseCount: search.selectedEmployee?.visible_expense_count ?? 0,
      filteredTotal: page?.filtered_total ?? null,
      activeFilters: {
        statuses: f.filters.statuses.length > 0,
        categories: f.filters.categories.length > 0,
        timePeriod: f.filters.timePeriod !== "all",
        actionableOnly: f.filters.actionableOnly,
        customFilters: f.filters.customFilters.length > 0,
        generalSearch: Boolean(search.generalSearch),
      },
      queryShapeKey: buildQueryShapeKey(queryShape),
    });
  }, [employeeContractBreach, search.selectedEmployee, page, f.filters, search.generalSearch, queryShape]);

  /** Keeps the employee selected and returns to their unfiltered expenses. */
  const clearFiltersKeepEmployee = useCallback(() => {
    f.resetContentFilters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const totalPages =
    page && page.total_pages > 0
      ? page.total_pages
      : Math.max(1, Math.ceil((page?.filtered_total ?? 0) / f.filters.pageSize));
  /** The page-number controls need the anchor RPC; hide them without it. */
  const jumpEnabled = capabilities.capabilities?.functions.page_anchor === true;
  // Paging controls stay disabled through restoration: a click mid-restore would race the
  // anchor resolution and land the reviewer on a page neither of them chose.
  const busy = queue.isFetching || busyLabel !== null || restoring;

  const scrollToTable = useCallback(() => {
    tableTopRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  const startNavigation = useCallback(
    (label: string) => {
      setBusyLabel(label);
      clearSelection();
      setDetailId(null);
    },
    [clearSelection],
  );

  const goNext = useCallback(() => {
    if (busy || !page?.next_cursor) return;
    startNavigation(t("admin:review.progress.loadingPage", { page: pager.pageNumber + 1 }));
    pager.goNext(page.next_cursor);
    scrollToTable();
  }, [busy, page, pager, startNavigation, scrollToTable, t]);

  const goPrevious = useCallback(() => {
    if (busy || !pager.canGoPrevious) return;
    startNavigation(t("admin:review.progress.loadingPage", { page: pager.pageNumber - 1 }));
    pager.goPrevious();
    scrollToTable();
  }, [busy, pager, startNavigation, scrollToTable, t]);

  /**
   * A cached page is reached directly; anything else costs one anchor RPC then
   * one page RPC. On failure the current page is left exactly as it was — a
   * half-applied jump would show page N's number above page M's rows.
   */
  const goToPage = useCallback(
    async (target: number) => {
      if (busy || jumpInFlight.current || target === pager.pageNumber) return;
      startNavigation(t("admin:review.progress.loadingPage", { page: target }));
      scrollToTable();

      if (pager.goToCachedPage(target)) {
        setBusyLabel(null);
        return;
      }
      if (!organizationId || !jumpEnabled) {
        setBusyLabel(null);
        return;
      }

      jumpInFlight.current = true;
      try {
        const anchor = await fetchReviewQueuePageAnchor({
          organizationId,
          targetPage: target,
          pageSize: queryShape.pageSize,
          sort: queryShape.sort,
          employeeUserId: queryShape.employeeUserId,
          generalSearch: queryShape.generalSearch,
          statuses: queryShape.statuses.length ? queryShape.statuses : null,
          categories: queryShape.categories.length ? queryShape.categories : null,
          dateFrom: queryShape.dateFrom,
          dateTo: queryShape.dateTo,
          actionableOnly: queryShape.actionableOnly,
          customFilters: queryShape.customFilters,
        });
        pager.goToAnchoredPage(anchor.target_page, anchor.cursor);
      } catch {
        // Stay put. The list below is still the page the user was on.
      } finally {
        jumpInFlight.current = false;
        setBusyLabel(null);
      }
    },
    [busy, pager, startNavigation, scrollToTable, organizationId, jumpEnabled, queryShape, t],
  );

  // The navigation label is only meaningful while the fetch it named is running.
  useEffect(() => {
    if (!queue.isFetching && busyLabel && !jumpInFlight.current) setBusyLabel(null);
  }, [queue.isFetching, busyLabel]);

  /**
   * Dev-only contract check. With no search and no filters the card and the
   * pagination total describe the same population, so a mismatch means the
   * server is on an older revision — better a console warning than two
   * contradictory numbers rendered confidently.
   */
  const noFiltersActive =
    !queryShape.employeeUserId &&
    !queryShape.generalSearch &&
    queryShape.statuses.length === 0 &&
    queryShape.categories.length === 0 &&
    !queryShape.dateFrom &&
    !queryShape.dateTo &&
    !queryShape.actionableOnly &&
    queryShape.customFilters.length === 0;

  useEffect(() => {
    if (!import.meta.env.DEV || !page || !noFiltersActive) return;
    if (page.scope_summary.assigned_to_me !== page.filtered_total) {
      console.warn(
        "[reviewExpensesServer] assigned_to_me (%s) != filtered_total (%s) with no " +
          "filters active. Expected equality from database revision 20260802010000.",
        page.scope_summary.assigned_to_me,
        page.filtered_total,
      );
    }
  }, [page, noFiltersActive]);

  const progressLabel =
    // Restoration reuses the page's one progress surface rather than adding a second
    // loading system, and names what it is actually doing.
    (restoring ? t("admin:review.progress.restoring") : null) ??
    busyLabel ??
    (queue.isFetching && !page ? t("admin:review.progress.initial") : null) ??
    (queue.isFetching ? t("admin:review.progress.updating") : null);

  // ── Error / loading gates ────────────────────────────────────────────────
  const blockingError =
    capabilities.error ??
    (capabilities.capabilities && !capabilities.isReady
      ? new Error("capability-not-ready")
      : null);

  /**
   * Rows the reviewer has ticked, in the shape the action layer needs. Taken
   * from the CURRENT page only — a selection cannot outlive the rows it was
   * made on, because paging clears it.
   */
  const selectedRows: ActionableExpense[] = useMemo(
    () => items.filter((i) => selectedIds.has(i.id)) as unknown as ActionableExpense[],
    [items, selectedIds],
  );

  // Bulk-approve confirmation (DOC-080 §13). Only the selected rows that can
  // actually be approved are counted/summed — a mixed selection must not claim
  // to approve a verify-only row. The total is the SELECTED amount for the
  // dialog only; it is never treated as financial authority (the server
  // deducts and returns the real balances).
  const [confirmApproveOpen, setConfirmApproveOpen] = useState(false);
  const approvableSelectedRows = useMemo(
    () =>
      (items.filter(
        (i) => selectedIds.has(i.id) && i.available_actions.includes("approve"),
      ) as unknown as ActionableExpense[]),
    [items, selectedIds],
  );
  // Dialog numbers come from the pure, unit-tested helper (§13) so the count and
  // total shown to the reviewer match exactly what will be sent to V2.
  const approveSummary = useMemo(
    () => summarizeBulkApprove(items, selectedIds),
    [items, selectedIds],
  );

  const actions = useReviewExpenseActions({
    organizationId,
    userId: user?.id ?? null,
    reviewerRole: queue.page?.caller.role ?? userRole ?? null,
    onSuccess: () => {
      // The server is now the authority on this row; close the detail rather
      // than leaving a stale copy of it on screen.
      setDetailId(null);
      setDetailComment("");
      clearSelection();
    },
  });

  const bulk = useBulkReviewActions({
    userId: user?.id ?? null,
    reviewerRole: queue.page?.caller.role ?? userRole ?? null,
    onComplete: () => clearSelection(),
  });

  const header = (
    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-0">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t("admin:review.title")}</h1>
        <p className="text-sm sm:text-base text-muted-foreground mt-1">
          {t("admin:review.description")}
        </p>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 sm:space-y-6 lg:space-y-8" data-testid="review-server-page">
      {header}

      {blockingError ? (
        <ReviewErrorState
          kind={capabilities.error ? reviewErrorKind(capabilities.error) : "capability"}
          onRetry={() => capabilities.refetch()}
          onUseLegacy={onUseLegacy}
        />
      ) : (
        <>
          <ReviewStatsCards filtered={filtered} context={summaryContext} page={page} loading={queue.isLoading} moneyLocale={moneyLocale} />

          <Card>
            <CardHeader className="p-4 sm:p-6">
              <CardTitle className="text-lg sm:text-xl">
                {t("admin:review.assignedExpenses")}
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                {t("admin:review.assignedExpensesDescription")}
                {(userRole === "engineer" || isHierarchyReviewer) && (
                  <span className="block mt-1 text-muted-foreground">
                    {t("admin:review.approvedStayVisible")}
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 sm:p-6">
              {/* Search and Filter Bar — same row, same proportions */}
              <div className="flex flex-col sm:flex-row gap-3 mb-6">
                <ReviewSearchBar
                  draft={search.draft}
                  onDraftChange={search.setDraft}
                  onSubmit={search.submit}
                  onClearAll={search.clearAll}
                  searching={search.state === "searching"}
                  selectedEmployee={search.selectedEmployee}
                  generalSearch={search.generalSearch}
                  onClearEmployee={search.clearEmployee}
                  onClearGeneralSearch={search.clearGeneralSearch}
                >
                  {search.state === "choose_employee" && (
                    <ReviewEmployeeResultsPopover
                      matches={search.matches}
                      submitted={search.submitted}
                      onSelect={search.chooseEmployee}
                      onSearchExpensesInstead={search.searchExpensesInstead}
                      onDismiss={search.clearAll}
                    />
                  )}
                </ReviewSearchBar>

                <ReviewFilters
                  status={f.filters.statuses[0] ?? ALL}
                  onStatus={(v) => f.setStatuses(v === ALL ? [] : [v])}
                  sort={f.filters.sort}
                  onSort={(v: ReviewQueueSort) => f.setSort(v)}
                  timePeriod={f.filters.timePeriod}
                  onTimePeriod={(v: ReviewTimePeriod) => f.setTimePeriod(v)}
                  categories={filterOptions.categories}
                  category={f.filters.categories[0] ?? ALL}
                  onCategory={(v) => f.setCategories(v === ALL ? [] : [v])}
                />

                {/* Only offered when there is something to clear, so it never reads as a
                    control the reviewer has failed to use. */}
                {hasActiveQuery ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearSearchAndFilters}
                    disabled={busy}
                    data-testid="review-clear-search"
                    className="h-9 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="mr-1 h-4 w-4" />
                    {t("admin:review.clearSearch")}
                  </Button>
                ) : null}
              </div>

              <ReviewCustomFieldFilters
                options={filterOptions.options}
                customFilters={f.filters.customFilters}
                onChange={f.setCustomFilters}
                className="mb-6"
              />

              {REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED && (
                <ReviewBulkActions
                  selectedCount={selectedIds.size}
                  canVerify={items.some(
                    (i) => selectedIds.has(i.id) && i.available_actions.includes("verify"),
                  )}
                  canApprove={items.some(
                    (i) => selectedIds.has(i.id) && i.available_actions.includes("approve"),
                  )}
                  canReject={items.some(
                    (i) => selectedIds.has(i.id) && i.available_actions.includes("reject"),
                  )}
                  busy={bulk.busy}
                  onVerify={() => void bulk.bulkVerify(selectedRows)}
                  onApprove={() => setConfirmApproveOpen(true)}
                  onReject={() => {
                    // The legacy flow records the reason as the audit comment,
                    // so a rejection without one is refused rather than sent.
                    const reason = window.prompt(t("admin:review.rejectReasonPrompt"));
                    if (reason && reason.trim()) void bulk.bulkReject(selectedRows, reason.trim());
                  }}
                  onClear={clearSelection}
                />
              )}

              {search.error && <ReviewErrorState kind={reviewErrorKind(search.error)} />}

              {queue.error && (
                <ReviewErrorState
                  kind={reviewErrorKind(queue.error)}
                  onRetry={() => queue.refetch()}
                  onUseLegacy={onUseLegacy}
                />
              )}

              {/* One authoritative server request, so the state is running or
                  nothing — never a fabricated percentage, and never the old
                  "loading 4,000 of 7,450" partial-dataset message. */}
              <div ref={tableTopRef} aria-busy={busy || undefined}>
                {progressLabel && (
                  <AsyncOperationProgress
                    status="running"
                    title={progressLabel}
                    compact={Boolean(page)}
                    className="mb-3"
                  />
                )}

              {queue.isLoading && !page ? (
                <div className="min-h-[400px] space-y-3 pt-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : !queue.error && items.length === 0 ? (
                <div className="text-center py-8" data-testid="review-empty-state">
                  <Receipt className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium">{t("admin:review.noAssignedTitle")}</h3>
                  <p className="text-muted-foreground max-w-md mx-auto">
                    {/* Three genuinely different situations. The old copy used
                        "this employee has no expenses visible to you" for all of
                        them, which contradicts the employee search's own count
                        and reads as a fact about the data rather than about the
                        filters. */}
                    {employeeContractBreach
                      ? t("admin:review.errors.employeeContractBreach")
                      : search.selectedEmployee && (f.activeFilterCount > 0 || search.generalSearch)
                        ? t("admin:review.noMatchForEmployee", {
                            name: search.selectedEmployee.employee_name,
                          })
                        : search.selectedEmployee
                          ? t("admin:review.errors.employeeNoExpenses")
                          : search.generalSearch || f.activeFilterCount > 0
                            ? t("admin:review.errors.noMatchingExpenses")
                            : t("admin:review.noAssignedDefault")}
                  </p>
                  {/* Keeps the employee selected — clearing the whole search
                      would make the reviewer look them up again. */}
                  {search.selectedEmployee &&
                    (f.activeFilterCount > 0 || Boolean(search.generalSearch)) && (
                      <button
                        type="button"
                        className="mt-3 text-sm underline underline-offset-4"
                        data-testid="review-clear-filters-keep-employee"
                        onClick={clearFiltersKeepEmployee}
                      >
                        {t("admin:review.clearFiltersKeepEmployee")}
                      </button>
                    )}
                </div>
              ) : (
                items.length > 0 &&
                (isMobile ? (
                  <ReviewExpensesMobileList
                    items={items}
                    selectedIds={selectedIds}
                    onToggle={toggleRow}
                    onOpen={openExpense}
                    isSelectable={isSelectableForBulk}
                    actionsEnabled={REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED}
                    moneyLocale={moneyLocale}
                  />
                ) : (
                  <ReviewExpensesTable
                    items={items}
                    selectedIds={selectedIds}
                    onToggle={toggleRow}
                    onSelectAll={selectAll}
                    onOpen={openExpense}
                    isSelectable={isSelectableForBulk}
                    actionsEnabled={REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED}
                    moneyLocale={moneyLocale}
                  />
                ))
              )}

              </div>

              {page && items.length > 0 && (
                <ReviewPagination
                  pageNumber={pager.pageNumber}
                  pageSize={f.filters.pageSize}
                  returned={items.length}
                  filteredTotal={page.filtered_total}
                  totalPages={totalPages}
                  hasMore={page.has_more}
                  canGoPrevious={pager.canGoPrevious}
                  busy={busy}
                  jumpEnabled={jumpEnabled}
                  onPrevious={goPrevious}
                  onNext={goNext}
                  onGoToPage={(p) => void goToPage(p)}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Bulk-approve confirmation (DOC-080 §13). Count + selected total, then
          the same per-expense V2 path each individual approval uses. */}
      <AlertDialog open={confirmApproveOpen} onOpenChange={(v) => !bulk.busy && setConfirmApproveOpen(v)}>
        <AlertDialogContent data-testid="bulk-approve-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin:review.bulkApproveConfirmTitle", {
                count: approveSummary.count,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin:review.bulkApproveConfirmBody", {
                count: approveSummary.count,
                total: formatINR(approveSummary.total, moneyLocale),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {bulk.busy && bulk.progress ? (
            <p className="text-sm text-muted-foreground" data-testid="bulk-approve-progress">
              {t("admin:review.bulkApproveProgress", {
                completed: bulk.progress.completed,
                total: bulk.progress.total,
              })}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulk.busy}>
              {t("common:cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={bulk.busy || approvableSelectedRows.length === 0}
              data-testid="bulk-approve-confirm-action"
              onClick={(e) => {
                // Keep the dialog open while the sequential run reports progress;
                // close only after the server has answered for every row.
                e.preventDefault();
                void bulk.bulkApprove(approvableSelectedRows).finally(() =>
                  setConfirmApproveOpen(false),
                );
              }}
            >
              {t("admin:review.bulkApproveConfirmAction", {
                count: approveSummary.count,
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ReviewExpenseDetail
        open={detailId !== null}
        onOpenChange={(v) => !v && setDetailId(null)}
        detail={detail.detail}
        loading={detail.isLoading}
        error={detail.error}
        actionsEnabled={REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED}
        moneyLocale={moneyLocale}
        organizationId={organizationId}
        callerUserId={user?.id ?? null}
        pendingAction={actions.pending}
        comment={detailComment}
        onCommentChange={setDetailComment}
        onRetry={() => void detail.refetch()}
        onVerify={(e) => void actions.verify(e, detailComment.trim() || undefined)}
        onApprove={(e) => void actions.approve(e, detailComment.trim() || undefined)}
        onReject={(e, reason) => void actions.reject(e, reason)}
        onCorrect={(target) => {
          const d = detail.detail;
          if (!d) return;
          const raw = d.expense as Record<string, unknown>;
          const text = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
          setCorrectionSeed({
            expense: target,
            title: text("title"),
            destination: text("destination"),
            // The form stores one date; main seeded from trip_start.
            expenseDate: text("trip_start").slice(0, 10),
            purpose: text("purpose"),
            category: text("category"),
            amount: raw.total_amount == null ? "" : String(raw.total_amount),
            adminComment: text("admin_comment"),
          });
        }}
      />

      <ReviewCorrectionDialog
        open={correctionSeed !== null}
        onOpenChange={(v) => !v && setCorrectionSeed(null)}
        seed={correctionSeed}
        organizationId={organizationId}
        allowNestedConditional={allowNestedConditional}
        saving={actions.pending === "correct"}
        onSubmit={(target, input) => actions.correct(target, input)}
      />
    </div>
  );
}

export default ReviewExpensesServerPage;
