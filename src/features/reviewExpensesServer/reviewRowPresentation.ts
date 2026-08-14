/**
 * Row presentation rules, ported from origin/main:src/pages/EngineerReview.tsx.
 *
 * These are the exact predicates the proven Review Expenses table used to decide
 * what a row looks like and what its button says. They live here rather than
 * inside the table component so the desktop table, the mobile list and the tests
 * all read the same rules — main had them as closures on the page, which is why
 * they could not be reused.
 *
 * ONE substitution, and it is the point of the server queue: main recomputed
 * `isPendingForCurrentReviewer` on the client from status + tier + hierarchy
 * flags. The server's `is_actionable` is that same logic, ported into
 * `_debug_review_actionability_v1` and evaluated against data the client cannot
 * see. So `is_actionable` is read, never re-derived — re-deriving it is what let
 * the old page offer Verify on rows sitting at another reviewer's tier.
 */

import type { ReviewQueueItem } from "@/features/reviewQueueServer/types";

/** Main: `getExpenseReviewButtonLabel`. */
export function reviewButtonLabel(item: {
  status: string;
  is_actionable: boolean;
}): "View" | "View/Approve" {
  const status = (item.status || "").toLowerCase();
  if (status === "approved" || status === "rejected" || !item.is_actionable) return "View";
  return "View/Approve";
}

/**
 * Main styled the actionable button solid blue and the view-only one neutral
 * secondary. Returned as data so the table and the mobile list cannot drift.
 */
export function reviewButtonStyle(item: { is_actionable: boolean }): {
  variant: "default" | "secondary";
  className: string;
} {
  return item.is_actionable
    ? {
        variant: "default",
        className:
          "h-8 px-2 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap",
      }
    : { variant: "secondary", className: "h-8 px-2 text-xs font-normal whitespace-nowrap" };
}

/**
 * Batch button styling, driven by the server's whole-batch state.
 *
 * Main computed all-done / partial / all-pending from every line of the batch,
 * which it could do because it held all expenses in memory. The server page
 * holds one page, so the previous revision kept every button blue rather than
 * infer completion from a page slice — a batch whose remaining lines sat on
 * page 4 would have read as finished from page 1.
 *
 * `batch_action_state` now arrives from the server, computed across EVERY
 * assigned line of the batch, so the three-way colour is restored honestly.
 *
 * "Done" means no remaining action FOR THIS REVIEWER, which is why a
 * level_2_verified batch reads grey for the executive who verified it. It does
 * not require terminal status.
 *
 * A null state — a non-batch row, or a server older than 20260802030000 — falls
 * back to the pending blue. That is the only safe default: grey would claim a
 * batch is finished when the server never said so.
 */
export type BatchActionState = "all_pending" | "partial" | "all_done";

export function batchButtonStyle(state: BatchActionState | null | undefined): {
  variant: "default" | "secondary";
  className: string;
  label: string;
} {
  if (state === "all_done") {
    // Grey, but never disabled — the reviewer must still be able to reopen it.
    return {
      variant: "secondary",
      className: "h-8 px-2 text-xs font-normal whitespace-nowrap",
      label: "Review batch",
    };
  }
  if (state === "partial") {
    return {
      variant: "default",
      className:
        "h-8 px-2 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white whitespace-nowrap",
      label: "Review batch",
    };
  }
  return {
    variant: "default",
    className:
      "h-8 px-2 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap",
    label: "Review batch",
  };
}

/** Main: `isSelectableForBulk` — batch lines are never bulk-selectable. */
export function isRowSelectable(item: ReviewQueueItem): boolean {
  return (
    !item.batch_id &&
    item.is_actionable &&
    item.status !== "approved" &&
    item.status !== "rejected"
  );
}

/** Main: the `isResubmitted && (submitted|edited)` badge that replaces status. */
export function showsResubmittedInsteadOfStatus(item: {
  is_resubmitted: boolean;
  status: string;
}): boolean {
  return item.is_resubmitted && (item.status === "submitted" || item.status === "edited");
}

/**
 * Main: `getExpenseQueueHint` — "With <role>" when the row sits at a tier other
 * than the caller's. The server already computes the stage and the reason, so
 * the hint is derived from those instead of from raw status/tier guesswork.
 */
export function queueHint(
  item: { is_actionable: boolean; actionable_stage?: string; actionable_reason?: string },
  roleLabel: (tier: string) => string,
): string | null {
  if (item.is_actionable) return null;
  const reason = item.actionable_reason ?? "";
  if (reason.startsWith("awaiting_")) {
    const tier = reason.replace(/^awaiting_/, "").replace(/_tier$/, "");
    return `With ${roleLabel(tier)}`;
  }
  return null;
}

/** True when the balance cannot cover the expense — main coloured this red. */
export function balanceIsShort(item: {
  current_balance: number;
  total_amount: number | null;
}): boolean {
  return item.current_balance < Number(item.total_amount ?? 0);
}
