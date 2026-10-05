/**
 * Client-side classifier for the `enforce_expense_date_lock` trigger's
 * rejection (`supabase/migrations/20261018100000_expense_date_locking_v1.sql`,
 * `trg_enforce_expense_date_lock`).
 *
 * Mirrors the established pattern for a stable, user-safe SQLSTATE
 * (`src/lib/formatApiError.ts`'s `PW001`/`isOrgRequiredFieldsError`): the
 * trigger raises a dedicated `ERRCODE = 'PW010'` with `DETAIL =
 * 'EXPENSE_DATE_LOCKED'` specifically so the application can recognise this
 * one rejection without string-matching the human-readable message, the
 * same way `PGRST202`/`PGRST204`/`42703` etc. are already recognised by
 * `.code` elsewhere in this codebase (e.g. `src/lib/attachmentRemoval.ts`,
 * `src/lib/orgUsers.ts`).
 *
 * The shape checked here (`{ code, message, details, hint }`) is what
 * supabase-js hands back for a PostgREST-fronted `RAISE ... USING ERRCODE =
 * ..., DETAIL = ...` -- `DETAIL` surfaces as `.details`, same as the PW001
 * precedent's own test fixture documents.
 */

/** Stable SQLSTATE the date-lock enforcement trigger raises. */
export const EXPENSE_DATE_LOCKED_ERROR_CODE = "PW010";

/** Stable DETAIL the trigger raises alongside the SQLSTATE above. */
export const EXPENSE_DATE_LOCKED_ERROR_DETAIL = "EXPENSE_DATE_LOCKED";

/** The one friendly sentence every surface should show for this rejection. */
export const EXPENSE_DATE_LOCKED_MESSAGE = "This expense date is closed for submission.";

/**
 * Whether an error (thrown, or a `{ error }` result shape's `error` field)
 * is the date-lock trigger's rejection. Checks the SQLSTATE first (the
 * stable contract); falls back to the DETAIL marker alone in case a caller
 * only has access to a partially-shaped error object that dropped `.code`
 * but kept `.details` (some RPC wrappers in this codebase re-throw a
 * trimmed error).
 */
export function isExpenseDateLockedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; details?: unknown };
  if (e.code === EXPENSE_DATE_LOCKED_ERROR_CODE) return true;
  return e.details === EXPENSE_DATE_LOCKED_ERROR_DETAIL;
}

/**
 * Friendly message for this one specific rejection, or `null` if the error
 * is not it. Callers should try this BEFORE falling back to a generic
 * "Database error (CODE): message" style formatter (see
 * `src/lib/formatApiError.ts`'s `formatApiError`) so a locked-date rejection
 * never surfaces as a raw SQLSTATE to the employee.
 */
export function formatExpenseDateLockError(error: unknown): string | null {
  return isExpenseDateLockedError(error) ? EXPENSE_DATE_LOCKED_MESSAGE : null;
}
