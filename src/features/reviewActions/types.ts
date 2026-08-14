/**
 * Shared review-action contracts (DOC-080).
 *
 * These types describe the ORCHESTRATION around the existing ExpenseService
 * methods — they deliberately do not redefine the workflow. `verifyExpense`,
 * `approveExpense`, `rejectExpense` and `applySingularExpenseCorrection` already
 * enforce role, tier, hierarchy, approval limits, audit logging and
 * notifications; this layer only decides when to call them and what to do with
 * the result.
 */

export type ReviewActionKind = "verify" | "approve" | "reject" | "correct";

/** The minimum a row must expose for the layer to act on it. */
export type ActionableExpense = {
  id: string;
  transaction_number: string | null;
  batch_id: string | null;
  user_id: string;
  status: string;
  approval_tier: string | null;
  total_amount: number | null;
  /** Server-computed. Client eligibility is presentation only. */
  is_actionable: boolean;
  available_actions: string[];
  view_only: boolean;
};

export type ReviewActionResult = {
  expenseId: string;
  transactionNumber: string | null;
  action: ReviewActionKind;
  ok: boolean;
  /** Status the server reported after a successful transition. */
  resultingStatus?: string | null;
  error?: string;
  /** True when the row was never attempted because it was ineligible. */
  skipped?: boolean;
};

export type BulkActionSummary = {
  action: ReviewActionKind;
  totalSelected: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: ReviewActionResult[];
};

export type CorrectionInput = {
  updates: Record<string, unknown>;
  reason?: string | null;
  customFieldPatch?: unknown[];
};
