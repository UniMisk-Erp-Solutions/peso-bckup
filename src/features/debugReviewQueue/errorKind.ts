/**
 * Error-kind mapping for the debug page, kept out of the component file so
 * DebugReviewErrorState exports a component and nothing else.
 */

import { categorizeReviewQueueError } from "@/features/reviewQueueServer/errors";

export type DebugErrorKind =
  | "flag_disabled"
  | "capability"
  | "authorization"
  | "auth_expired"
  | "network"
  | "timeout"
  | "validation"
  | "unknown"
  | "employee_not_found"
  | "employee_no_expenses"
  | "no_matching_expenses";

/** Stable i18n key per kind — a raw database message never reaches the UI. */
export const DEBUG_ERROR_MESSAGE_KEY: Record<DebugErrorKind, string> = {
  flag_disabled: "errors.flagDisabled",
  capability: "errors.capability",
  authorization: "errors.authorization",
  auth_expired: "errors.authExpired",
  network: "errors.network",
  timeout: "errors.timeout",
  validation: "errors.validation",
  unknown: "errors.unknown",
  employee_not_found: "errors.employeeNotFound",
  employee_no_expenses: "errors.employeeNoExpenses",
  no_matching_expenses: "errors.noMatchingExpenses",
};

export function kindFromError(error: unknown): DebugErrorKind {
  const category = categorizeReviewQueueError(error);
  if (category === "capability") return "capability";
  if (category === "authorization") return "authorization";
  if (category === "timeout") return "timeout";
  if (category === "network") return "network";
  if (category === "validation") return "validation";
  return "unknown";
}
