/**
 * /review entry point (DOC-080 §3).
 *
 * Chooses between the existing EngineerReview implementation and the
 * server-backed one. The choice is made by a flag only — there is no automatic
 * fallback, because silently reverting to V1 when the server page fails would
 * hide the failure and reproduce the original "looks fine, wrong data" bug.
 *
 * EngineerReview.tsx is untouched and remains the default.
 */

import ManagerReview from "@/pages/EngineerReview";

/**
 * ONE canonical Review Expenses surface (owner decision).
 *
 * The earlier flag-switched server-backed page (ReviewExpensesServerPage) and the
 * separate /debug/review-expenses page were rejected. `/review` now always
 * renders the proven legacy EngineerReview / ManagerReview workflow — which is
 * exactly what Production already runs (VITE queue flag false). There is no
 * longer an "old vs new vs debug" Review from the user's point of view.
 *
 * Useful Debug-Review UX (zero-request employee search, expense search,
 * server-safe pagination) is being promoted INTO this page, not kept as a second
 * surface.
 */
export default function ReviewExpenses() {
  return <ManagerReview />;
}
