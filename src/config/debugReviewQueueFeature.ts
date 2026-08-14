/**
 * Debug Review Expenses rollout flags (DOC-080).
 *
 * Both default OFF. The debug page is an independent validation surface — it must
 * never take over /review, and it must never silently fall back to V1 or to the
 * unfinished Review Queue V2 implementation.
 */

/** Mounts /debug/review-expenses and its sidebar entry. Exact string "true" only. */
export const DEBUG_REVIEW_EXPENSES_ENABLED =
  (import.meta.env.VITE_DEBUG_REVIEW_EXPENSES_ENABLED as string | undefined)?.trim() === "true";

/** Enables verify/approve/reject/correct. Read-only until explicitly turned on. */
export const DEBUG_REVIEW_ACTIONS_ENABLED =
  (import.meta.env.VITE_DEBUG_REVIEW_ACTIONS_ENABLED as string | undefined)?.trim() === "true";

/** Contract the client requires from debug_review_queue_capabilities_v1(). */
export const DEBUG_REVIEW_CONTRACT = "debug-review-queue";
export const DEBUG_REVIEW_REQUIRED_VERSION = 1;
