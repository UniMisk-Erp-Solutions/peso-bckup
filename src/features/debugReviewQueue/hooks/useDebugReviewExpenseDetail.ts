/**
 * Debug expense detail (DOC-080). Shared core, scoped to the debug cache so a
 * debug page can never feed the production page.
 */

import { useReviewExpenseDetail } from "@/features/reviewQueueServer/hooks/useReviewExpenseDetail";
import { DEBUG_REVIEW_EXPENSES_ENABLED } from "@/config/debugReviewQueueFeature";
import { expenseDetailKey } from "@/features/reviewQueueServer/queryKeys";

export function debugExpenseDetailKey(organizationId: string | null, expenseId: string | null) {
  return expenseDetailKey("debug", organizationId, expenseId);
}

export function useDebugReviewExpenseDetail(params: {
  organizationId: string | null;
  expenseId: string | null;
  ready: boolean;
}) {
  return useReviewExpenseDetail({
    scope: "debug",
    organizationId: params.organizationId,
    expenseId: params.expenseId,
    enabled: DEBUG_REVIEW_EXPENSES_ENABLED && params.ready,
  });
}
