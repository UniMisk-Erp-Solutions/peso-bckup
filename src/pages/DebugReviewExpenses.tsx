/**
 * Route entry for /debug/review-expenses (DOC-080 Phase 22).
 *
 * Thin wrapper so the route can be lazy-loaded without pulling the whole debug
 * feature into the main bundle. /review is untouched.
 */

import { DebugReviewExpensesPage } from "@/features/debugReviewQueue/DebugReviewExpensesPage";

export default function DebugReviewExpenses() {
  return <DebugReviewExpensesPage />;
}
