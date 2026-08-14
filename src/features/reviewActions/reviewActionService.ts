/**
 * Review action orchestration (DOC-080 §5).
 *
 * This is a THIN layer over the existing, already-working ExpenseService
 * methods. It deliberately does not reimplement the workflow:
 *
 *   verify  -> ExpenseService.verifyExpense, which itself routes team_leader and
 *              executive callers into advanceExpenseTier, so tier advancement,
 *              executive handoff and final verification all behave exactly as
 *              they do on the legacy page. It must NOT be shortcut to
 *              "set status = verified".
 *   approve -> ExpenseService.approveExpense (balance deduction, approval limits)
 *   reject  -> ExpenseService.rejectExpense
 *   correct -> ExpenseService.applySingularExpenseCorrection
 *
 * Every one of those re-derives the caller's organization and role from the
 * database and refuses unauthorized callers, so the flag check and eligibility
 * check below are guardrails, not the security boundary.
 */

import { ExpenseService } from "@/services/ExpenseService";
import { supabase } from "@/integrations/supabase/client";
import { REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED } from "@/config/reviewQueueServerFeature";
import {
  ActionNotAvailableError,
  ActionsDisabledError,
  SelfReviewError,
  SessionExpiredError,
} from "./errors";
import { canPerform, isSelfOwned } from "./actionEligibility";
import type {
  ActionableExpense,
  CorrectionInput,
  ReviewActionKind,
  ReviewActionResult,
} from "./types";

/** Bounded so a large selection cannot open dozens of parallel mutations. */
export const BULK_CONCURRENCY = 3;

export type ActionContext = {
  userId: string | null;
  reviewerRole: string | null;
  comment?: string | null;
};

/**
 * The hard guard. Every mutation path calls this FIRST, before touching the
 * network — hiding a button is not an enforcement mechanism.
 */
export function assertActionsEnabled(): void {
  if (!REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED) throw new ActionsDisabledError();
}

/** A mutation must never be attempted on a dead session. */
async function assertSession(): Promise<void> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new SessionExpiredError();
}

function assertAllowed(
  expense: ActionableExpense,
  action: ReviewActionKind,
  ctx: ActionContext,
): void {
  if (isSelfOwned(expense, ctx.userId)) throw new SelfReviewError();
  if (!canPerform(expense, action, ctx.userId)) throw new ActionNotAvailableError(action);
}

// ── Single actions ──────────────────────────────────────────────────────────

export async function verifyExpense(
  expense: ActionableExpense,
  ctx: ActionContext,
): Promise<string | null> {
  assertActionsEnabled();
  assertAllowed(expense, "verify", ctx);
  await assertSession();
  if (!ctx.userId) throw new SessionExpiredError();

  // verifyExpense routes hierarchy reviewers into advanceExpenseTier internally,
  // so the resulting status may be level_1_verified / level_2_verified / verified.
  const updated = await ExpenseService.verifyExpense(
    expense.id,
    ctx.userId,
    ctx.comment ?? undefined,
    { reviewerRole: ctx.reviewerRole },
  );
  return updated?.status ?? null;
}

export async function approveExpense(
  expense: ActionableExpense,
  ctx: ActionContext,
): Promise<string | null> {
  assertActionsEnabled();
  assertAllowed(expense, "approve", ctx);
  await assertSession();
  if (!ctx.userId) throw new SessionExpiredError();

  const updated = await ExpenseService.approveExpense(
    expense.id,
    ctx.userId,
    ctx.comment ?? undefined,
  );
  return updated?.status ?? null;
}

export async function rejectExpense(
  expense: ActionableExpense,
  ctx: ActionContext,
  reason: string,
): Promise<string | null> {
  assertActionsEnabled();
  assertAllowed(expense, "reject", ctx);
  const trimmed = (reason ?? "").trim();
  // The legacy flow carries the reason as the audit comment; an empty one would
  // leave a rejection with no recorded justification.
  if (!trimmed) throw new Error("A rejection reason is required.");
  await assertSession();
  if (!ctx.userId) throw new SessionExpiredError();

  const updated = await ExpenseService.rejectExpense(expense.id, ctx.userId, trimmed);
  return updated?.status ?? null;
}

export async function correctExpense(
  expense: ActionableExpense,
  ctx: ActionContext,
  input: CorrectionInput,
): Promise<void> {
  assertActionsEnabled();
  assertAllowed(expense, "correct", ctx);
  await assertSession();
  if (!ctx.userId) throw new SessionExpiredError();

  await ExpenseService.applySingularExpenseCorrection(
    expense.id,
    ctx.userId,
    input.updates as never,
    input.reason ?? null,
    input.customFieldPatch as never,
  );
}

// ── Bulk ────────────────────────────────────────────────────────────────────

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Results keep input order regardless of completion order, so a summary can be
 * read against the selection the reviewer made.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let inFlight = 0;
  let completed = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      inFlight += 1;
      try {
        results[index] = await worker(items[index], index);
      } finally {
        inFlight -= 1;
        completed += 1;
        onSettled?.(completed, items.length);
      }
    }
  }

  // limit === 1 gives strictly sequential execution (one run() loop), which is
  // what financial approvals use so the same employee's expenses settle in
  // order and never contend on the profile lock.
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => run()),
  );
  return results;
}

export async function runBulkAction(
  expenses: ActionableExpense[],
  action: Exclude<ReviewActionKind, "correct">,
  ctx: ActionContext,
  reason?: string,
  opts?: { concurrency?: number; onProgress?: (completed: number, total: number) => void },
): Promise<ReviewActionResult[]> {
  assertActionsEnabled();

  // Approvals move money, so they run strictly sequentially (concurrency 1);
  // verify/reject keep the bounded pool. Callers may override.
  const concurrency =
    opts?.concurrency ?? (action === "approve" ? 1 : BULK_CONCURRENCY);

  return mapWithConcurrency(expenses, concurrency, async (expense) => {
    const base = {
      expenseId: expense.id,
      transactionNumber: expense.transaction_number,
      action,
    };
    try {
      let resultingStatus: string | null = null;
      if (action === "verify") resultingStatus = await verifyExpense(expense, ctx);
      else if (action === "approve") resultingStatus = await approveExpense(expense, ctx);
      else resultingStatus = await rejectExpense(expense, ctx, reason ?? "");
      return { ...base, ok: true, resultingStatus } satisfies ReviewActionResult;
    } catch (error) {
      return {
        ...base,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ReviewActionResult;
    }
  }, opts?.onProgress);
}
