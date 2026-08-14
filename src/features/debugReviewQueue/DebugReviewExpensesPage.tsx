/**
 * Debug Review Expenses — independent validation surface (DOC-080).
 *
 * This page never touches the V1 loading pipeline or the Review Queue V2 RPCs.
 * Its whole job is to prove three things a reviewer can check by hand:
 *
 *  1. Typing in Employee Search issues ZERO network requests.
 *  2. Employee Search resolves to an immutable user_id and never matches a
 *     transaction number — searching 6174 returns employee 6174's expenses, not
 *     transaction 06174 belonging to employee 6557.
 *  3. Pagination is server-side keyset, so "all 24" really means all 24.
 *
 * Mutations are disabled throughout.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/auth-context";
import {
  DEBUG_REVIEW_ACTIONS_ENABLED,
  DEBUG_REVIEW_EXPENSES_ENABLED,
} from "@/config/debugReviewQueueFeature";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { useIsMobile } from "@/hooks/use-mobile";
import { DebugEmployeeResults } from "./DebugEmployeeResults";
import { DebugEmployeeSearch } from "./DebugEmployeeSearch";
import { DebugGeneralSearch } from "./DebugGeneralSearch";
import { DebugReviewDiagnostics } from "./DebugReviewDiagnostics";
import { DebugReviewErrorState } from "./DebugReviewErrorState";
import { kindFromError } from "./errorKind";
import { DebugReviewExpenseDetail } from "./DebugReviewExpenseDetail";
import { DebugReviewFilters } from "./DebugReviewFilters";
import { DebugReviewMobileList } from "./DebugReviewMobileList";
import { DebugReviewPagination } from "./DebugReviewPagination";
import { DebugReviewStats } from "./DebugReviewStats";
import { DebugReviewTable } from "./DebugReviewTable";
import { useDebugEmployeeSearch } from "./hooks/useDebugEmployeeSearch";
import { useDebugReviewCapabilities } from "./hooks/useDebugReviewCapabilities";
import { useDebugReviewDiagnostics } from "./hooks/useDebugReviewDiagnostics";
import { useDebugReviewExpenseDetail } from "./hooks/useDebugReviewExpenseDetail";
import { useDebugReviewFilterOptions } from "./hooks/useDebugReviewFilterOptions";
import { timePeriodToRange, useDebugReviewFilters } from "./hooks/useDebugReviewFilters";
import { useDebugReviewPage } from "./hooks/useDebugReviewPage";

export function DebugReviewExpensesPage() {
  const { t } = useTranslation("debugReview");
  const { user, userRole, organizationId } = useAuth();
  const isMobile = useIsMobile();

  const [detailId, setDetailId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const capabilities = useDebugReviewCapabilities();
  const employeeSearch = useDebugEmployeeSearch(organizationId);
  const f = useDebugReviewFilters();

  const filterOptions = useDebugReviewFilterOptions({
    organizationId,
    userId: user?.id ?? null,
    ready: capabilities.isReady,
  });

  // `all` yields no date bounds; anything else is a rolling window ending today.
  const range = useMemo(
    () => timePeriodToRange(f.filters.timePeriod, new Date()),
    [f.filters.timePeriod],
  );

  const queue = useDebugReviewPage({
    organizationId,
    userId: user?.id ?? null,
    // The immutable user_id — never the employee name.
    employeeUserId: employeeSearch.selected?.user_id ?? null,
    generalSearch: f.submittedGeneralSearch,
    statuses: f.filters.statuses,
    categories: f.filters.categories,
    dateFrom: range.from,
    dateTo: range.to,
    actionableOnly: f.filters.actionableOnly,
    customFilters: f.filters.customFilters,
    sort: f.filters.sort,
    pageSize: f.filters.pageSize,
    cursor: f.cursor,
    ready: capabilities.isReady,
  });

  const detail = useDebugReviewExpenseDetail({
    organizationId,
    expenseId: detailId,
    ready: capabilities.isReady,
  });

  const { diagnostics, text: diagnosticsText } = useDebugReviewDiagnostics({
    contract: capabilities.capabilities?.contract ?? null,
    contractVersion: capabilities.capabilities?.version ?? null,
    capabilityReady: capabilities.isReady,
    functions: capabilities.capabilities?.functions ?? null,
    schemaRevision: capabilities.capabilities?.schema_revision ?? null,
    reviewerRole: queue.page?.caller.role ?? userRole ?? null,
    organizationId,
    selectedEmployeeId: employeeSearch.selected?.employee_id ?? null,
    selectedEmployeeUserId: employeeSearch.selected?.user_id ?? null,
    submittedEmployeeSearch: employeeSearch.submitted,
    submittedGeneralSearch: f.submittedGeneralSearch,
    pageSize: f.filters.pageSize,
    logicalPage: f.pageNumber,
    filteredTotal: queue.page?.filtered_total ?? null,
    returnedRows: queue.page?.diagnostics.page_returned ?? null,
    hasMore: queue.page?.has_more ?? null,
    currentCursor: f.cursor,
    nextCursor: queue.page?.next_cursor ?? null,
    requestDurationMs: queue.getLastDurationMs(),
    identityResolved: queue.page?.diagnostics.identity_resolved ?? null,
    identityUnresolved: queue.page?.diagnostics.identity_unresolved ?? null,
    error: queue.error,
    timestamp: new Date().toISOString(),
  });

  /** Selecting a different employee invalidates the cursor sequence. */
  const selectEmployee = (match: Parameters<typeof employeeSearch.select>[0]) => {
    employeeSearch.select(match);
    f.resetPagination();
    setSelectedIds(new Set());
  };

  const clearEmployee = () => {
    employeeSearch.clear();
    f.resetPagination();
    setSelectedIds(new Set());
  };

  const header = (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{t("pageTitle")}</h1>
        <Badge variant="outline" data-testid="debug-actions-disabled-badge">
          {t("actionsDisabled")}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t("pageDescription")}</p>
    </div>
  );

  if (!DEBUG_REVIEW_EXPENSES_ENABLED) {
    return (
      <div className="space-y-4 p-4" data-testid="debug-review-page">
        {header}
        <DebugReviewErrorState kind="flag_disabled" />
      </div>
    );
  }

  const employeeLabel = employeeSearch.selected
    ? `${employeeSearch.selected.employee_name}${
        employeeSearch.selected.employee_id ? ` · ${employeeSearch.selected.employee_id}` : ""
      }`
    : null;

  const showEmptyState =
    capabilities.isReady && !queue.isLoading && !queue.error && queue.items.length === 0;

  return (
    <div className="space-y-4 p-4" data-testid="debug-review-page">
      {header}

      {/* 1 — contract status */}
      {capabilities.isLoading && <Skeleton className="h-10 w-full" />}
      {capabilities.error && (
        <DebugReviewErrorState
          kind={kindFromError(capabilities.error)}
          missingFunctions={capabilities.missingFunctions}
          onRetry={() => capabilities.refetch()}
        />
      )}
      {capabilities.capabilities && !capabilities.isReady && (
        <DebugReviewErrorState
          kind="capability"
          missingFunctions={capabilities.missingFunctions}
          onRetry={() => capabilities.refetch()}
        />
      )}
      {capabilities.isReady && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <Badge variant="secondary" data-testid="debug-contract-ready">
              {t("contractReady")}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {t("contractRevision", {
                revision: capabilities.capabilities?.schema_revision ?? "",
              })}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">{t("readOnlyNotice")}</span>
          </CardContent>
        </Card>
      )}

      {/* 2 — KPI cards */}
      <DebugReviewStats page={queue.page} loading={queue.isLoading} />

      {/* 3/4 — employee search + selection */}
      <DebugEmployeeSearch
        draft={employeeSearch.draft}
        onDraftChange={employeeSearch.setDraft}
        onSubmit={employeeSearch.submit}
        onClear={clearEmployee}
        state={employeeSearch.state}
        selected={employeeSearch.selected}
        submitted={employeeSearch.submitted}
      />
      {employeeSearch.state === "needs_selection" && (
        <DebugEmployeeResults matches={employeeSearch.matches} onSelect={selectEmployee} />
      )}
      {employeeSearch.state === "error" && (
        <DebugReviewErrorState kind={kindFromError(employeeSearch.error)} />
      )}

      {/* 5 — general expense search */}
      <DebugGeneralSearch
        draft={f.draftGeneralSearch}
        onDraftChange={f.setDraftGeneralSearch}
        onSubmit={f.submitGeneralSearch}
        onClear={f.clearGeneralSearch}
      />

      {/* 6/7 — filters */}
      <DebugReviewFilters
        filters={f.filters}
        options={filterOptions.options}
        activeFilterCount={f.activeFilterCount}
        onStatuses={f.setStatuses}
        onCategories={f.setCategories}
        onTimePeriod={f.setTimePeriod}
        onActionableOnly={f.setActionableOnly}
        onCustomFilters={f.setCustomFilters}
        onSort={f.setSort}
        onPageSize={f.setPageSize}
        onReset={f.resetAll}
      />

      {/* 8 — server-paginated results */}
      {queue.error && (
        <DebugReviewErrorState kind={kindFromError(queue.error)} onRetry={() => queue.refetch()} />
      )}

      {queue.isLoading && !queue.page && <Skeleton className="h-64 w-full" />}

      {showEmptyState && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            <p data-testid="debug-empty-state">
              {employeeSearch.selected || f.submittedGeneralSearch || f.activeFilterCount > 0
                ? t("empty.noResults")
                : t("empty.noEmployeeSelected")}
            </p>
          </CardContent>
        </Card>
      )}

      {queue.items.length > 0 &&
        (isMobile ? (
          <DebugReviewMobileList items={queue.items} onView={setDetailId} />
        ) : (
          <DebugReviewTable
            items={queue.items}
            selectedIds={selectedIds}
            onToggle={(id) =>
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onView={setDetailId}
            actionsEnabled={DEBUG_REVIEW_ACTIONS_ENABLED}
          />
        ))}

      {queue.page && (
        <DebugReviewPagination
          pageNumber={f.pageNumber}
          pageSize={f.filters.pageSize}
          returned={queue.items.length}
          filteredTotal={queue.page.filtered_total}
          hasMore={queue.page.has_more}
          canGoPrevious={f.canGoPrevious}
          onPrevious={f.goPrevious}
          onNext={() => f.goNext(queue.page?.next_cursor ?? null)}
          employeeLabel={employeeLabel}
        />
      )}

      {/* 9 — diagnostics */}
      <DebugReviewDiagnostics
        diagnostics={diagnostics}
        text={diagnosticsText}
        defaultOpen={!isMobile}
      />

      {/* 10 — detail */}
      <DebugReviewExpenseDetail
        open={detailId !== null}
        onOpenChange={(v) => !v && setDetailId(null)}
        detail={detail.detail}
        loading={detail.isLoading}
        error={detail.error}
      />
    </div>
  );
}

export default DebugReviewExpensesPage;
