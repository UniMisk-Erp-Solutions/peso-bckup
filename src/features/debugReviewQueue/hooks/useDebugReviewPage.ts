/**
 * Debug queue page (DOC-080). Shared core, debug-scoped cache.
 */

import { useReviewQueuePage } from "@/features/reviewQueueServer/hooks/useReviewQueuePage";
import { DEBUG_REVIEW_EXPENSES_ENABLED } from "@/config/debugReviewQueueFeature";
import {
  reviewQueuePageKey,
  type ReviewQueuePageKeyInput,
} from "@/features/reviewQueueServer/queryKeys";

export type DebugReviewPageQueryInput = ReviewQueuePageKeyInput;

export function debugReviewPageKey(i: DebugReviewPageQueryInput) {
  return reviewQueuePageKey("debug", i);
}

export function useDebugReviewPage(input: DebugReviewPageQueryInput & { ready: boolean }) {
  const { ready, ...rest } = input;
  return useReviewQueuePage("debug", {
    ...rest,
    enabled: DEBUG_REVIEW_EXPENSES_ENABLED && ready,
  });
}
