/**
 * Shared Manager Review row/batch presentation state (DEV feature, §10/§11/§31).
 *
 * ONE contract for the three visual states so the singular button, the batch
 * button and the mobile action card can never drift:
 *
 *   ready     → BLUE   — actionable by the current reviewer right now
 *   waiting   → AMBER  — visible but not yet at this reviewer's stage
 *                        (e.g. still with Team Leader / Executive)
 *   completed → GREY   — terminal / finished (approved, rejected, paid)
 *
 * Pure and presentation-only. It NEVER decides authorization — the caller passes
 * server/client-derived `isReadyNow` and `isTerminal`, and financial approval is
 * always re-authorized server-side by review_approve_expense_v2.
 */

export type ReviewRowState = "ready" | "waiting" | "completed";

/**
 * Terminal review statuses — a row here is finished (grey) and never selectable
 * for bulk action. One source of truth so the desktop table, the batch button
 * and the mobile card can never disagree on what "done" means.
 */
export const TERMINAL_REVIEW_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  "rejected",
  "paid",
]);

export function isTerminalReviewStatus(status: string | null | undefined): boolean {
  return TERMINAL_REVIEW_STATUSES.has((status ?? "").toLowerCase());
}

/** Classify a row from two already-computed booleans. Terminal wins. */
export function reviewRowState(input: {
  isReadyNow: boolean;
  isTerminal: boolean;
}): ReviewRowState {
  if (input.isTerminal) return "completed";
  return input.isReadyNow ? "ready" : "waiting";
}

export type ReviewStatePresentation = {
  state: ReviewRowState;
  /** shadcn Button variant to use. */
  variant: "default" | "secondary" | "outline";
  /** Extra classes; blue for ready, amber for waiting, neutral for completed. */
  className: string;
  /** Whether a checkbox may be shown for this state (completed → no). */
  selectable: boolean;
};

/**
 * Presentation for a state. Amber deliberately uses the same amber-500 family the
 * existing batch "partial" button uses, so singular and batch colours match.
 */
export function reviewStatePresentation(state: ReviewRowState): ReviewStatePresentation {
  switch (state) {
    case "ready":
      return {
        state,
        variant: "default",
        className:
          "h-8 px-2 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap",
        selectable: true,
      };
    case "waiting":
      return {
        state,
        variant: "default",
        className:
          "h-8 px-2 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white whitespace-nowrap",
        selectable: true,
      };
    case "completed":
    default:
      return {
        state: "completed",
        variant: "secondary",
        className: "h-8 px-2 text-xs font-normal whitespace-nowrap",
        // Truly finished work is not selectable for bulk action.
        selectable: false,
      };
  }
}

/**
 * Classify a batch from its CHILDREN (not from a pending-count) into the shared
 * 3-state, so a batch and a singular row use one colour scale.
 *
 * The earlier model called a batch "all-done" (grey) whenever no child was ready
 * for the current reviewer — which wrongly greyed a batch that is merely WAITING
 * at an earlier hierarchy stage (e.g. a Manager viewing an executive-tier batch,
 * where every child has isReadyNow=false but none are terminal). Correct rule:
 *   all children terminal              → completed (grey)
 *   any non-terminal child ready now   → ready (blue)
 *   otherwise (non-terminal, waiting)  → waiting (amber)
 */
export function batchReviewState(
  children: ReadonlyArray<{ isReadyNow: boolean; isTerminal: boolean }>,
): ReviewRowState {
  if (children.length === 0) return "completed";
  if (children.every((c) => c.isTerminal)) return "completed";
  if (children.some((c) => !c.isTerminal && c.isReadyNow)) return "ready";
  return "waiting";
}
