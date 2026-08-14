/**
 * Debug filter state (DOC-080). Wraps the shared filter/cursor hook and adds the
 * debug page's own second search box, which /review deliberately does not have.
 */

import { useCallback, useState } from "react";
import {
  buildQueryShapeKey,
  useReviewQueueFilters,
} from "@/features/reviewQueueServer/hooks/useReviewQueueFilters";
import { useCursorHistory } from "@/features/reviewQueueServer/hooks/useCursorHistory";

export { REVIEW_PAGE_SIZES as DEBUG_PAGE_SIZES, timePeriodToRange } from "@/features/reviewQueueServer/hooks/useReviewQueueFilters";
export type { ReviewQueueFilterState as DebugReviewFilterState } from "@/features/reviewQueueServer/hooks/useReviewQueueFilters";

export function useDebugReviewFilters() {
  const base = useReviewQueueFilters();
  const [draftGeneralSearch, setDraftGeneralSearch] = useState("");
  const [submittedGeneralSearch, setSubmittedGeneralSearch] = useState<string | null>(null);

  // The debug page keeps its own cursor walk; it has no page-jump controls.
  const cursors = useCursorHistory(
    buildQueryShapeKey({
      organizationId: null,
      employeeUserId: null,
      generalSearch: submittedGeneralSearch,
      // Folded in so a period change invalidates cached cursors too.
      dateFrom: base.filters.timePeriod,
      dateTo: null,
      statuses: base.filters.statuses,
      categories: base.filters.categories,
      actionableOnly: base.filters.actionableOnly,
      customFilters: base.filters.customFilters,
      sort: base.filters.sort,
      pageSize: base.filters.pageSize,
    }),
  );

  /** Runs ONLY from a submit handler — never from an effect on the draft. */
  const submitGeneralSearch = useCallback(() => {
    const trimmed = draftGeneralSearch.trim();
    setSubmittedGeneralSearch(trimmed === "" ? null : trimmed);
    cursors.reset();
  }, [draftGeneralSearch, cursors]);

  /** Clears ONLY the expense search. The selected employee is untouched. */
  const clearGeneralSearch = useCallback(() => {
    setDraftGeneralSearch("");
    setSubmittedGeneralSearch(null);
    cursors.reset();
  }, [cursors]);

  const resetAll = useCallback(() => {
    base.resetFilters();
    setDraftGeneralSearch("");
    setSubmittedGeneralSearch(null);
  }, [base]);

  return {
    ...base,
    ...cursors,
    resetPagination: cursors.reset,
    draftGeneralSearch,
    setDraftGeneralSearch,
    submittedGeneralSearch,
    submitGeneralSearch,
    clearGeneralSearch,
    resetAll,
  };
}
