/**
 * Debug Review Queue contracts (DOC-080).
 *
 * Thin alias layer over the shared core in `@/features/reviewQueueServer`. The
 * debug page and /review must never diverge on response shapes, identity parsing
 * or error classification, so there is exactly one implementation and this file
 * only renames it for the debug call sites.
 */

export {
  formatEmployeeIdentity,
  identityIssueLabel,
  REVIEW_QUEUE_SORTS as DEBUG_REVIEW_SORTS,
} from "@/features/reviewQueueServer/types";

export type {
  ReviewQueueSort as DebugReviewSort,
  ReviewQueueCapabilities as DebugReviewCapabilities,
  ReviewEmployeeMatch as DebugEmployeeMatch,
  ReviewEmployeeSearchResult as DebugEmployeeSearchResult,
  ReviewQueueCursor as DebugReviewCursor,
  ReviewQueueItem as DebugReviewQueueItem,
  ReviewSelectedEmployee as DebugSelectedEmployee,
  ReviewQueuePage as DebugReviewPage,
  ReviewQueueFilterOptions as DebugReviewFilterOptions,
  ReviewQueueExpenseDetail as DebugReviewExpenseDetail,
  ReviewCustomField as DebugCustomField,
  ReviewCustomFilter as DebugCustomFilter,
  ReviewTimePeriod as DebugTimePeriod,
} from "@/features/reviewQueueServer/types";

export {
  ReviewQueueCapabilityError as DebugReviewCapabilityError,
  ReviewQueueAuthorizationError as DebugReviewAuthorizationError,
  ReviewQueueValidationError as DebugReviewValidationError,
  ReviewQueueTimeoutError as DebugReviewTimeoutError,
  ReviewQueueNetworkError as DebugReviewNetworkError,
  ReviewQueueUnknownError as DebugReviewUnknownError,
  categorizeReviewQueueError as categorizeDebugReviewError,
} from "@/features/reviewQueueServer/errors";

export type { ReviewQueueErrorCategory as DebugReviewErrorCategory } from "@/features/reviewQueueServer/errors";
