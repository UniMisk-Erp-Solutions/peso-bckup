/**
 * Debug filter metadata (DOC-080). Shared core, debug-scoped cache.
 */

import { useReviewQueueFilterOptions } from "@/features/reviewQueueServer/hooks/useReviewQueueFilterOptions";
import { DEBUG_REVIEW_EXPENSES_ENABLED } from "@/config/debugReviewQueueFeature";
import { filterOptionsKey } from "@/features/reviewQueueServer/queryKeys";

export function debugFilterOptionsKey(organizationId: string | null, userId: string | null) {
  return filterOptionsKey("debug", organizationId, userId);
}

export function useDebugReviewFilterOptions(params: {
  organizationId: string | null;
  userId: string | null;
  ready: boolean;
}) {
  return useReviewQueueFilterOptions({
    scope: "debug",
    organizationId: params.organizationId,
    userId: params.userId,
    enabled: DEBUG_REVIEW_EXPENSES_ENABLED && params.ready,
  });
}
