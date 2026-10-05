/**
 * Pure reference model for Review Expenses' Month / relative-Time-Period
 * mutual exclusion (§14-21 of the month-filter hardening audit).
 *
 * EngineerReview.tsx has no render harness (its data pipeline needs far more
 * Supabase query-builder mocking than the shared test setup provides -- the
 * same situation documented for its other pure-logic extractions), so this
 * module exists to make the mutual-exclusion CONTRACT itself directly,
 * behaviorally testable: given a sequence of user actions, does Month ever
 * get silently clobbered, and does an unrelated draft ever get clobbered?
 * EngineerReview.tsx's actual inline state transitions implement the same
 * rules (see the source-contract tests that check its wiring matches this
 * shape); this file is the executable spec they're checked against.
 */
import { ALL_MONTHS, type ExpenseMonthValue } from "@/lib/expenseMonthFilter";

export type ReviewDateModeState = {
  /** Applied relative time period ("all" | "week" | "month" | "year" | mobile's 7d/30d/3m/6m/1y). */
  timePeriod: string;
  /** Applied exact calendar month, mutually exclusive with timePeriod. */
  expenseMonth: ExpenseMonthValue;
  /** The desktop Time Period dropdown's staged (not-yet-applied) value. */
  draftTimePeriod: string;
};

export function initialReviewDateModeState(): ReviewDateModeState {
  return { timePeriod: "all", expenseMonth: ALL_MONTHS, draftTimePeriod: "all" };
}

/**
 * Month applies immediately (no draft gate), on both desktop and mobile.
 * Touching Month -- selecting an exact month OR explicitly resetting to "All
 * months" -- always forces the relative period back to "all" in BOTH applied
 * and draft state, so no stale relative period can ever reactivate later.
 */
export function selectExpenseMonth(
  state: ReviewDateModeState,
  month: ExpenseMonthValue,
): ReviewDateModeState {
  return { ...state, expenseMonth: month, timePeriod: "all", draftTimePeriod: "all" };
}

/** Desktop: editing the Time Period dropdown stages a DRAFT only -- zero applied-state change. */
export function stageTimePeriodDraft(state: ReviewDateModeState, value: string): ReviewDateModeState {
  return { ...state, draftTimePeriod: value };
}

/**
 * Desktop: pressing Search commits the staged draft. A deliberately-committed
 * non-"all" relative period always resets Month back to "All months" (kept,
 * pre-existing behavior); a committed "all" leaves whatever Month is already
 * selected untouched -- it does NOT reactivate anything, it just declines to
 * clear it.
 */
export function commitDraftTimePeriod(state: ReviewDateModeState): ReviewDateModeState {
  const nextExpenseMonth = state.draftTimePeriod !== "all" ? ALL_MONTHS : state.expenseMonth;
  return { ...state, timePeriod: state.draftTimePeriod, expenseMonth: nextExpenseMonth };
}

/**
 * Mobile: the Time Period control applies immediately -- there is no draft
 * gate on mobile at all. Selecting a non-"all" relative period there must
 * enforce the SAME mutual exclusion desktop's Search-commit enforces.
 */
export function selectTimePeriodImmediate(
  state: ReviewDateModeState,
  value: string,
): ReviewDateModeState {
  return {
    ...state,
    timePeriod: value,
    draftTimePeriod: value,
    expenseMonth: value !== "all" ? ALL_MONTHS : state.expenseMonth,
  };
}
