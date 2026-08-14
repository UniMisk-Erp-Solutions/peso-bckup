/**
 * Debug capability probe (DOC-080). Shared core, debug-scoped cache.
 */

import { useReviewQueueCapabilities } from "@/features/reviewQueueServer/hooks/useReviewQueueCapabilities";
import { DEBUG_REVIEW_EXPENSES_ENABLED } from "@/config/debugReviewQueueFeature";
import { capabilitiesKey } from "@/features/reviewQueueServer/queryKeys";

export const DEBUG_CAPABILITIES_KEY = capabilitiesKey("debug");

export function useDebugReviewCapabilities(options?: { enabled?: boolean }) {
  return useReviewQueueCapabilities(
    "debug",
    (options?.enabled ?? true) && DEBUG_REVIEW_EXPENSES_ENABLED,
  );
}
