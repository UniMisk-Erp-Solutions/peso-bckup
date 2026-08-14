/**
 * The single production search bar (DOC-080 §7 / §9).
 *
 * Same position, same width and the same leading magnifier as the existing
 * Review Expenses search field — one input, not the debug page's two large
 * sections. A Search button sits inside the field's right edge so the filter row
 * keeps its current proportions.
 *
 * Typing issues zero requests: the input is bound to `draft`, which nothing
 * observes. There is no effect on it and no debounce, because a debounce still
 * fires while typing.
 */

import { useTranslation } from "react-i18next";
import { Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { ReviewSelectedEmployee } from "@/features/reviewQueueServer/types";

export function ReviewSearchBar({
  draft,
  onDraftChange,
  onSubmit,
  onClearAll,
  searching,
  selectedEmployee,
  selectedEmployeeCount,
  countError,
  generalSearch,
  onClearEmployee,
  onClearGeneralSearch,
  children,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSubmit: () => void;
  onClearAll: () => void;
  searching: boolean;
  selectedEmployee: ReviewSelectedEmployee | null;
  /**
   * The count shown on the employee chip. This is the AUTHORITATIVE filtered
   * Review result total (from the queue RPC), not the employee-search response's
   * `visible_expense_count` (which is an identity-resolution artifact and can be
   * 0/stale). `null` = not yet known → show "loading", never a false "0" (§4/§5).
   */
  selectedEmployeeCount?: number | null;
  /** True when the filtered query failed/timed out — show a retry hint, not "counting…". */
  countError?: boolean;
  generalSearch: string | null;
  onClearEmployee: () => void;
  onClearGeneralSearch: () => void;
  /** The disambiguation popover, anchored to this field. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation("admin");

  return (
    <div className="flex-1 relative">
      <form
        onSubmit={(e) => {
          // Enter inside the input submits the form — the only path to the RPC
          // besides the Search button.
          e.preventDefault();
          onSubmit();
        }}
      >
        <Search className="absolute left-3 top-[1.15rem] -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
        <Input
          data-testid="review-search-input"
          value={draft}
          placeholder={t("review.searchPlaceholder")}
          autoComplete="off"
          aria-label={t("review.searchAriaLabel")}
          className="pl-10 pr-[6.5rem]"
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <div className="absolute right-1 top-1 flex items-center gap-1">
          {(draft || selectedEmployee || generalSearch) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2"
              onClick={onClearAll}
              aria-label={t("review.clear")}
              data-testid="review-search-clear"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            className="h-8"
            disabled={searching}
            data-testid="review-search-submit"
          >
            {searching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("review.search")
            )}
          </Button>
        </div>
      </form>

      {children}

      {/* Compact chips — deliberately not the debug page's large card. The two
          filter kinds are labelled separately so they can never read as one. */}
      {(selectedEmployee || generalSearch) && (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="review-search-chips">
          {selectedEmployee && (
            <Badge
              variant="secondary"
              className="gap-1 font-normal"
              data-testid="review-employee-chip"
            >
              <span className="truncate max-w-[16rem]">
                {selectedEmployee.employee_name}
                {selectedEmployee.employee_id ? ` · ${selectedEmployee.employee_id}` : ""}
              </span>
              <span
                className={countError ? "text-destructive" : "text-muted-foreground"}
                data-testid="review-employee-count"
              >
                {countError
                  ? t("review.countError")
                  : selectedEmployeeCount == null
                    ? t("review.countLoading")
                    : t("review.visibleExpensesCount", { count: selectedEmployeeCount })}
              </span>
              <button
                type="button"
                onClick={onClearEmployee}
                aria-label={t("review.clearEmployee")}
                data-testid="review-clear-employee"
                className="ml-0.5 rounded-sm hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {generalSearch && (
            <Badge
              variant="outline"
              className="gap-1 font-normal"
              data-testid="review-general-chip"
            >
              <span className="truncate max-w-[16rem]">
                {t("review.searchChip", { term: generalSearch })}
              </span>
              <button
                type="button"
                onClick={onClearGeneralSearch}
                aria-label={t("review.clearSearch")}
                data-testid="review-clear-general"
                className="ml-0.5 rounded-sm hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}
