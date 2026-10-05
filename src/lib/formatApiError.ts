/**
 * SQLSTATE raised by validate_expense_org_required_fields_v1 when an
 * organization's mandatory expense fields are incomplete at submission time
 * (migration 20260907120000_organization_required_expense_fields.sql).
 *
 * It is deliberately distinct from the generic 23514 / P0001 a plain constraint
 * or RAISE produces, so the application can recognise this one specific,
 * user-actionable failure without string-matching an error message.
 */
export const ORG_REQUIRED_FIELDS_ERROR_CODE = "PW001";

/** Whether an error is the organization mandatory-field policy rejection. */
export function isOrgRequiredFieldsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === ORG_REQUIRED_FIELDS_ERROR_CODE;
}

/** Human-readable message from Supabase/PostgREST errors, fetch failures, etc. */
export function formatApiError(error: unknown, fallback = "Unknown error"): string {
  // The organization mandatory-field rejection carries the user-facing sentence
  // in `message` and the specific field names in `details`. Both matter: the
  // sentence alone does not tell the user WHICH project detail is missing.
  if (isOrgRequiredFieldsError(error)) {
    const e = error as { message?: unknown; details?: unknown };
    const message = typeof e.message === "string" ? e.message.trim() : "";
    const details = typeof e.details === "string" ? e.details.trim() : "";
    if (message && details) return `${message} ${details}`;
    if (message) return message;
    if (details) return details;
  }

  if (error instanceof Error) return error.message || fallback;
  if (error && typeof error === "object") {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
    const details = (error as { details?: unknown }).details;
    if (typeof details === "string" && details.trim()) return details;
    const hint = (error as { hint?: unknown }).hint;
    if (typeof hint === "string" && hint.trim()) return hint;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
