/**
 * Which summary the KPI cards describe (DOC-080 §12).
 *
 * The cards previously always read `scope_summary`, which the server aggregates
 * over the whole assigned scope BEFORE any filter predicate. So selecting
 * employee 6174 left them reading 7,721 while the table showed that employee's
 * rows — cards and table answering different questions on one screen.
 *
 * The rule is simply: describe whatever the table is showing.
 */

import type { ReviewQueuePage } from "@/features/reviewQueueServer/types";

export type SummaryContext =
  | { kind: "global" }
  | { kind: "employee"; name: string; employeeId: string | null }
  | { kind: "search" };

/** Anything that narrows the population the table pages through. */
export function hasContentFilter(input: {
  employeeUserId: string | null;
  generalSearch: string | null;
  statuses: string[];
  categories: string[];
  timePeriod: string;
  actionableOnly: boolean;
  customFilterCount: number;
}): boolean {
  return Boolean(
    input.employeeUserId ||
      input.generalSearch ||
      input.statuses.length ||
      input.categories.length ||
      input.timePeriod !== "all" ||
      input.actionableOnly ||
      input.customFilterCount > 0,
  );
}

export type SummaryChoice =
  | { state: "ready"; summary: NonNullable<ReviewQueuePage["filtered_summary"]>; filtered: boolean }
  | { state: "loading" }
  /** The server predates `filtered_summary`; showing zeros would be a lie. */
  | { state: "unsupported" };

/**
 * `filtered_summary` is nullable on purpose. An older server omits it, and
 * rendering "Completed 0" from a missing field would read as a real count.
 * That case returns `unsupported` so the UI can say so instead.
 */
export function chooseSummary(
  page: ReviewQueuePage | null,
  filtered: boolean,
): SummaryChoice {
  if (!page) return { state: "loading" };
  if (!filtered) {
    const s = page.scope_summary;
    return {
      state: "ready",
      filtered: false,
      summary: {
        assigned_to_me: s.assigned_to_me,
        pending_review: s.pending_review,
        completed_review: s.completed_review,
        verified: s.verified,
        approved: s.approved,
        rejected: s.rejected,
        paid: s.paid,
        other_terminal: s.other_terminal,
        actionable_now: s.actionable_now,
        active_not_actionable_now: s.active_not_actionable_now,
        unclassified: s.unclassified,
        total_amount: s.total_amount,
        reconciliation_ok: s.reconciliation_ok,
      },
    };
  }
  if (!page.filtered_summary) return { state: "unsupported" };
  return { state: "ready", filtered: true, summary: page.filtered_summary };
}

/**
 * The filtered summary must describe exactly the rows the table pages through.
 * `filtered_total` counts the same relation, so any disagreement is a defect.
 */
export function filteredSummaryMatchesTotal(page: ReviewQueuePage | null): boolean {
  if (!page?.filtered_summary) return true;
  return page.filtered_summary.assigned_to_me === page.filtered_total;
}
