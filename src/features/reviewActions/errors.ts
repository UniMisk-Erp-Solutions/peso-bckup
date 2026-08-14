/**
 * Review-action errors (DOC-080).
 *
 * The distinction that matters operationally: an ActionsDisabledError means the
 * flag is off and nothing was attempted, whereas an AuthorizationError means a
 * request reached the server and was refused. Reporting the first as the second
 * would send someone hunting for a permissions bug that does not exist.
 */

export class ActionsDisabledError extends Error {
  constructor(message = "Review actions are not enabled.") {
    super(message);
    this.name = "ActionsDisabledError";
  }
}

export class ActionNotAvailableError extends Error {
  constructor(action: string) {
    super(`This expense does not currently allow "${action}".`);
    this.name = "ActionNotAvailableError";
  }
}

export class SelfReviewError extends Error {
  constructor(message = "You cannot review your own expense.") {
    super(message);
    this.name = "SelfReviewError";
  }
}

export class SessionExpiredError extends Error {
  constructor(message = "Your session has expired. Sign in again to continue.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export class StaleExpenseError extends Error {
  constructor(message = "This expense changed since it was loaded. Refreshing.") {
    super(message);
    this.name = "StaleExpenseError";
  }
}

/**
 * Maps a thrown error to a message safe to show a reviewer.
 *
 * ExpenseService already throws readable business messages ("You don't have
 * permission to review this expense", approval-limit text, and so on), so those
 * are passed through rather than replaced — losing them would make a genuine
 * refusal indistinguishable from a bug.
 */
export function reviewActionMessage(error: unknown): string {
  if (error instanceof ActionsDisabledError) return error.message;
  if (error instanceof ActionNotAvailableError) return error.message;
  if (error instanceof SelfReviewError) return error.message;
  if (error instanceof SessionExpiredError) return error.message;
  if (error instanceof StaleExpenseError) return error.message;

  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/jwt|401|unauthor/i.test(raw)) return new SessionExpiredError().message;
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return raw || "The action could not be completed.";
}

/** True when the failure means the session must be recovered, not retried. */
export function isSessionFailure(error: unknown): boolean {
  if (error instanceof SessionExpiredError) return true;
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return /jwt|401|unauthor/i.test(raw);
}
