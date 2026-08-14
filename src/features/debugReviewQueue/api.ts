/**
 * Debug Review Queue RPC layer (DOC-080).
 *
 * Alias layer over the shared core in `@/features/reviewQueueServer/api`. The
 * debug page and /review call the same functions against the same proven RPCs —
 * there is no second copy of the argument construction or the validation.
 */

export {
  fetchReviewQueueCapabilities as fetchDebugReviewCapabilities,
  fetchReviewQueuePage as fetchDebugReviewPage,
  fetchReviewQueueFilterOptions as fetchDebugReviewFilterOptions,
  fetchReviewExpenseDetail as fetchDebugReviewExpenseDetail,
  searchReviewEmployees as searchDebugReviewEmployees,
  parseCapabilities,
  parseEmployeeSearch,
  parseReviewQueuePage as parseDebugReviewPage,
  parseFilterOptions,
  parseExpenseDetail,
  pickAutoSelectableMatch,
  REVIEW_QUEUE_RPCS,
} from "@/features/reviewQueueServer/api";

export type { ReviewQueuePageParams as DebugReviewPageParams } from "@/features/reviewQueueServer/api";
