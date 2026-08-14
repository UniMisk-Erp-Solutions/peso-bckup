/**
 * Pagination controls (DOC-080 Phase 18).
 *
 * Next is driven by the server's `has_more`, which is exact because the RPC
 * fetches page_size + 1. No guessed total page count is rendered — with keyset
 * paging the only honest numbers are the window and the filtered total.
 */

import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pageWindow } from "./format";

export function DebugReviewPagination({
  pageNumber,
  pageSize,
  returned,
  filteredTotal,
  hasMore,
  canGoPrevious,
  onPrevious,
  onNext,
  employeeLabel,
}: {
  pageNumber: number;
  pageSize: number;
  returned: number;
  filteredTotal: number;
  hasMore: boolean;
  canGoPrevious: boolean;
  onPrevious: () => void;
  onNext: () => void;
  employeeLabel: string | null;
}) {
  const { t } = useTranslation("debugReview");
  const { from, to } = pageWindow(pageNumber, pageSize, returned);

  const summary =
    returned === 0
      ? t("pagination.empty")
      : employeeLabel
        ? t("pagination.showingForEmployee", {
            from,
            to,
            total: filteredTotal,
            employee: employeeLabel,
          })
        : t("pagination.showing", { from, to, total: filteredTotal });

  return (
    <div
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid="debug-pagination"
    >
      <p className="text-sm text-muted-foreground" data-testid="debug-pagination-summary">
        {summary}
      </p>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canGoPrevious}
          onClick={onPrevious}
          data-testid="debug-page-previous"
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          {t("pagination.previous")}
        </Button>

        <span className="px-2 text-sm tabular-nums" data-testid="debug-page-number">
          {t("pagination.page", { page: pageNumber })}
        </span>

        <Button
          size="sm"
          variant="outline"
          disabled={!hasMore}
          onClick={onNext}
          data-testid="debug-page-next"
        >
          {t("pagination.next")}
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
