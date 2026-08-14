/**
 * Server review-queue contracts (DOC-080).
 *
 * Types are derived from the Zod schemas so the compile-time shape and the
 * runtime validation can never drift apart. Shared by /review and
 * /debug/review-expenses.
 */

import type { z } from "zod";
import type {
  debugCustomFieldSchema,
  debugEmployeeMatchSchema,
  debugEmployeeSearchSchema,
  debugExpenseDetailSchema,
  debugFilterOptionsSchema,
  debugReviewCapabilitiesSchema,
  debugReviewCursorSchema,
  debugReviewPageSchema,
  debugReviewQueueItemSchema,
  debugPageAnchorSchema,
  debugReviewSortSchema,
  debugSelectedEmployeeSchema,
} from "./schemas";

export { DEBUG_REVIEW_SORTS as REVIEW_QUEUE_SORTS } from "./schemas";

export type ReviewQueueSort = z.infer<typeof debugReviewSortSchema>;
export type ReviewQueueCapabilities = z.infer<typeof debugReviewCapabilitiesSchema>;
export type ReviewEmployeeMatch = z.infer<typeof debugEmployeeMatchSchema>;
export type ReviewEmployeeSearchResult = z.infer<typeof debugEmployeeSearchSchema>;
export type ReviewQueueCursor = z.infer<typeof debugReviewCursorSchema>;
export type ReviewQueueItem = z.infer<typeof debugReviewQueueItemSchema>;
export type ReviewSelectedEmployee = z.infer<typeof debugSelectedEmployeeSchema>;
export type ReviewQueuePage = z.infer<typeof debugReviewPageSchema>;
export type ReviewQueueFilterOptions = z.infer<typeof debugFilterOptionsSchema>;
export type ReviewQueueExpenseDetail = z.infer<typeof debugExpenseDetailSchema>;
export type ReviewCustomField = z.infer<typeof debugCustomFieldSchema>;
export type ReviewPageAnchor = z.infer<typeof debugPageAnchorSchema>;
/** One custom-field definition with its place in the conditional tree. */
export type ReviewFilterField = ReviewQueueFilterOptions["custom_fields"][number];

/** One custom-field predicate. AND across entries, OR within `values`. */
export type ReviewCustomFilter = {
  source: "template" | "branch";
  field_id: string;
  values: string[];
};

export type ReviewTimePeriod = "all" | "week" | "month" | "year";

/**
 * Display priority: name+ID, name+email, ID, email, Unknown employee.
 * Never returns a bare dash — an identity issue is more useful than punctuation.
 */
export function formatEmployeeIdentity(item: {
  employee_name: string | null;
  employee_id: string | null;
  employee_email: string | null;
  identity_issue?: string | null;
}): { primary: string; secondary: string | null } {
  const name = item.employee_name?.trim();
  const hasName = Boolean(name) && name !== "Unknown employee";
  if (hasName && item.employee_id) return { primary: name!, secondary: item.employee_id };
  if (hasName && item.employee_email) return { primary: name!, secondary: item.employee_email };
  if (hasName) return { primary: name!, secondary: null };
  if (item.employee_id) return { primary: item.employee_id, secondary: null };
  if (item.employee_email) return { primary: item.employee_email, secondary: null };
  return { primary: "Unknown employee", secondary: identityIssueLabel(item.identity_issue) };
}

/** Maps an identity issue to a stable i18n key suffix. Never a bare dash. */
export function identityIssueLabel(issue: string | null | undefined): string | null {
  if (issue === "profile_missing") return "profileMissing";
  if (issue === "duplicate_profiles") return "duplicateProfiles";
  return null;
}
