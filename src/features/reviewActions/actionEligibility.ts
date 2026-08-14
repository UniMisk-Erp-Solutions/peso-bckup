/**
 * Client-side action eligibility (DOC-080 §7).
 *
 * PRESENTATION ONLY. Every function here decides what to render; nothing here
 * authorizes anything. ExpenseService re-checks role, tier, assignment and
 * approval limits server-side on every call, and that is the check that counts.
 *
 * Eligibility is read from the server's `available_actions` / `view_only`, never
 * inferred from status. Inferring from status is what let the old page offer
 * Verify on rows sitting at another reviewer's tier.
 */

import type { ActionableExpense, ReviewActionKind } from "./types";

/** A reviewer must never act on their own expense, whatever the server said. */
export function isSelfOwned(expense: ActionableExpense, callerUserId: string | null): boolean {
  return Boolean(callerUserId) && expense.user_id === callerUserId;
}

export function canPerform(
  expense: ActionableExpense,
  action: ReviewActionKind,
  callerUserId: string | null,
): boolean {
  if (isSelfOwned(expense, callerUserId)) return false;
  if (expense.view_only) return false;
  if (!expense.is_actionable) return false;
  return expense.available_actions.includes(action);
}

/**
 * Batch rows route to the batch-review page instead of acting inline — one line
 * of a batch is not the batch, and treating it as such would silently approve
 * the rest.
 */
export function requiresBatchReview(expense: ActionableExpense): boolean {
  return Boolean(expense.batch_id);
}

/** Rows a bulk operation may touch. Batch rows are excluded outright. */
export function eligibleForBulk(
  expenses: ActionableExpense[],
  action: ReviewActionKind,
  callerUserId: string | null,
): { eligible: ActionableExpense[]; skipped: ActionableExpense[] } {
  const eligible: ActionableExpense[] = [];
  const skipped: ActionableExpense[] = [];
  for (const e of expenses) {
    if (!requiresBatchReview(e) && canPerform(e, action, callerUserId)) eligible.push(e);
    else skipped.push(e);
  }
  return { eligible, skipped };
}

/** The actions to render for one row, in the order the legacy page shows them. */
export function visibleActions(
  expense: ActionableExpense,
  callerUserId: string | null,
): ReviewActionKind[] {
  const order: ReviewActionKind[] = ["verify", "approve", "reject", "correct"];
  return order.filter((a) => canPerform(expense, a, callerUserId));
}
