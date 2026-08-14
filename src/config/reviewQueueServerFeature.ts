/**
 * Server-backed Review Expenses rollout flags (DOC-080).
 *
 * Both default OFF. The queue flag swaps the DATA LAYER behind /review; the
 * actions flag is separate because a working read-only queue is not evidence
 * that mutations are safe. They are deliberately independent so the page can be
 * proven read-only in Preview before anything can be written.
 *
 * These are distinct from the debug page's flags — /debug/review-expenses keeps
 * its own, so turning one off never affects the other.
 */

/** Renders the server-backed Review Expenses page instead of EngineerReview. */
export const REVIEW_EXPENSES_SERVER_QUEUE_ENABLED =
  (import.meta.env.VITE_REVIEW_EXPENSES_SERVER_QUEUE_ENABLED as string | undefined)?.trim() ===
  "true";

/** Enables verify/approve/reject/correct on the server-backed page. */
export const REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED =
  (import.meta.env.VITE_REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED as string | undefined)?.trim() ===
  "true";

/**
 * Shows an explicit "Use legacy Review Expenses" escape hatch on the error
 * state. Never an automatic fallback — a silent swap back to V1 would hide the
 * very failure this page exists to surface.
 */
export const REVIEW_EXPENSES_LEGACY_ESCAPE_HATCH = import.meta.env.DEV === true;
