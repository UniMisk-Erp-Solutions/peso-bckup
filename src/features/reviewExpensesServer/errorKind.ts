/**
 * Production error-kind mapping (DOC-080 §18). Kept out of the component file so
 * ReviewErrorState exports a component only.
 */

import { categorizeReviewQueueError } from "@/features/reviewQueueServer/errors";

export type ReviewErrorKind =
  | "capability"
  | "session_expired"
  | "unauthorized"
  | "timeout"
  | "network"
  | "malformed"
  | "employee_not_found"
  | "employee_no_expenses"
  | "no_matching_expenses"
  | "unknown";

/** Production wording only — a raw database message never reaches a reviewer. */
export const REVIEW_ERROR_MESSAGE_KEY: Record<ReviewErrorKind, string> = {
  capability: "review.errors.unavailable",
  session_expired: "review.errors.sessionExpired",
  unauthorized: "review.errors.unauthorized",
  timeout: "review.errors.timeout",
  network: "review.errors.network",
  malformed: "review.errors.malformed",
  employee_not_found: "review.errors.employeeNotFound",
  employee_no_expenses: "review.errors.employeeNoExpenses",
  no_matching_expenses: "review.errors.noMatchingExpenses",
  unknown: "review.errors.unknown",
};

export function reviewErrorKind(error: unknown): ReviewErrorKind {
  switch (categorizeReviewQueueError(error)) {
    case "capability":
      return "capability";
    case "authorization":
      return "unauthorized";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "validation":
      return "malformed";
    default:
      return "unknown";
  }
}
