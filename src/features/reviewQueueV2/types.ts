/**
 * Review Queue V2 contracts (DOC-079).
 *
 * These are hand-maintained because the RPCs return a single JSONB document and
 * `src/integrations/supabase/types.ts` is stale (it omits tables the app already
 * uses). Nothing here fabricates a generated database column — every field maps to
 * a value the V2 SQL explicitly builds. Responses are validated at runtime by
 * `parseReviewQueuePage` / `parseReviewFilterOptions` before use.
 *
 * Deliberately absent: `manager_queue_ready` (client-computed in V1, replaced by
 * `is_actionable` + `actionable_reason` + `actionable_stage`) and `submitted_at`
 * (no such column — the server returns a computed `sort_at`).
 */

export const REVIEW_QUEUE_SORTS = ["newest", "oldest", "amount_high", "amount_low"] as const;
export type ReviewQueueSortV2 = (typeof REVIEW_QUEUE_SORTS)[number];

/** How the server resolved the submitter's identity for a row (DOC-079 §7). */
export const IDENTITY_SOURCES = [
  "current_profile",
  "inactive_profile",
  "expense_snapshot",
  "auth_user",
  "deterministic_reimport",
  "unresolved",
] as const;
export type ReviewIdentitySourceV2 = (typeof IDENTITY_SOURCES)[number];

export type ReviewCustomFieldValueV2 = {
  source: "template" | "branch";
  field_id: string;
  field_key: string;
  label: string;
  value: string;
};

export type ReviewCustomFieldFilterV2 = {
  source: "template" | "branch";
  field_id: string;
  values: string[];
};

/** Every ordering component required by the active sort. */
export type ReviewQueueCursorV2 = {
  sort_at: string;
  id: string;
  total_amount: string | null;
};

export type ReviewQueueItemV2 = {
  id: string;
  transaction_number: string | null;
  batch_id: string | null;
  user_id: string;
  employee_name: string;
  employee_email: string | null;
  employee_id: string | null;
  /** Provenance of the identity above — never fabricated, never guessed. */
  identity_source: ReviewIdentitySourceV2;
  current_balance: number;
  title: string;
  purpose: string | null;
  category: string | null;
  destination: string | null;
  total_amount: number | null;
  status: string;
  approval_tier: string | null;
  created_at: string | null;
  updated_at: string | null;
  sort_at: string;
  is_resubmitted: boolean;
  was_reviewer_corrected: boolean;
  is_actionable: boolean;
  actionable_reason: string | null;
  actionable_stage: "team_leader" | "executive" | "engineer" | "admin" | null;
  custom_fields: ReviewCustomFieldValueV2[];
};

export type ReviewQueuePageV2 = {
  version: 2;
  sort: ReviewQueueSortV2;
  page_size: number;
  total: number;
  next_cursor: ReviewQueueCursorV2 | null;
  items: ReviewQueueItemV2[];
};

export type ReviewQueueFiltersV2 = {
  search?: string | null;
  statuses?: string[] | null;
  categories?: string[] | null;
  userIds?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  actionableOnly?: boolean;
  customFilters?: ReviewCustomFieldFilterV2[];
};

export type ReviewFilterOptionsV2 = {
  version: 2;
  statuses: string[];
  categories: string[];
  employees: { user_id: string; name: string; employee_id: string | null }[];
  custom_fields: {
    source: "template" | "branch";
    field_id: string;
    field_key: string;
    label: string;
    options: unknown;
  }[];
};

// ── Typed errors ────────────────────────────────────────────────────────────

export class ReviewQueueCapabilityError extends Error {
  constructor(message = "Review Queue V2 database migration is not installed.") {
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
  constructor(message = "The review queue took too long to respond.") {
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
  constructor(message = "Review expenses are temporarily unavailable. Please contact your administrator.") {
    super(message);
    this.name = "ReviewQueueUnknownError";
  }
}
