/**
 * Typed errors for the server-backed review queue (DOC-080).
 *
 * Shared by /review and /debug/review-expenses. Every error the UI can show maps
 * to a stable category, so a raw Postgres message never reaches a reviewer.
 */

export class ReviewQueueCapabilityError extends Error {
  constructor(message = "Review queue database contract is not installed.") {
    super(message);
    this.name = "ReviewQueueCapabilityError";
  }
}
export class ReviewQueueAuthorizationError extends Error {
  constructor(message = "You are not authorized to review these expenses.") {
    super(message);
    this.name = "ReviewQueueAuthorizationError";
  }
}
export class ReviewQueueValidationError extends Error {
  constructor(message = "The review queue response was not in the expected format.") {
    super(message);
    this.name = "ReviewQueueValidationError";
  }
}
export class ReviewQueueTimeoutError extends Error {
  constructor(message = "The review queue query took too long to respond.") {
    super(message);
    this.name = "ReviewQueueTimeoutError";
  }
}
export class ReviewQueueNetworkError extends Error {
  constructor(message = "Could not reach the review queue.") {
    super(message);
    this.name = "ReviewQueueNetworkError";
  }
}
export class ReviewQueueUnknownError extends Error {
  constructor(message = "Review expenses are temporarily unavailable.") {
    super(message);
    this.name = "ReviewQueueUnknownError";
  }
}

export type ReviewQueueErrorCategory =
  | "capability"
  | "authorization"
  | "validation"
  | "timeout"
  | "network"
  | "unknown";

export function categorizeReviewQueueError(error: unknown): ReviewQueueErrorCategory {
  if (error instanceof ReviewQueueCapabilityError) return "capability";
  if (error instanceof ReviewQueueAuthorizationError) return "authorization";
  if (error instanceof ReviewQueueValidationError) return "validation";
  if (error instanceof ReviewQueueTimeoutError) return "timeout";
  if (error instanceof ReviewQueueNetworkError) return "network";
  return "unknown";
}

const RPC_MISSING = "PGRST202";
const STATEMENT_TIMEOUT = "57014";

/** Maps a PostgREST/Supabase error onto the typed hierarchy above. */
export function translateRpcError(error: { code?: string; message?: string } | null): Error {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (code === RPC_MISSING || /debug_review_/.test(message)) {
    return new ReviewQueueCapabilityError();
  }
  if (
    code === "42501" ||
    code === "28000" ||
    /not an authorized reviewer|not visible/i.test(message)
  ) {
    return new ReviewQueueAuthorizationError();
  }
  if (code === STATEMENT_TIMEOUT || /timeout/i.test(message)) return new ReviewQueueTimeoutError();
  if (/failed to fetch|networkerror|load failed/i.test(message)) return new ReviewQueueNetworkError();
  if (code === "22023") return new ReviewQueueValidationError(message);
  return new ReviewQueueUnknownError();
}
