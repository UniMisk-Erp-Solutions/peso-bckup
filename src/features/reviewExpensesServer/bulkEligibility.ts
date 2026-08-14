/**
 * Bulk-selection eligibility (DOC-080 §17).
 *
 * Kept out of the component file so ReviewBulkActions exports a component only.
 * Eligibility is ENTIRELY server-derived: `available_actions` and `view_only`,
 * never "status is not terminal", which would offer actions on rows sitting at
 * another reviewer's tier.
 */

import type { ReviewQueueItem } from "@/features/reviewQueueServer/types";

export function isBulkEligible(item: ReviewQueueItem, action: string): boolean {
  if (item.batch_id) return false;
  if (item.view_only) return false;
  if (!item.is_actionable) return false;
  return item.available_actions.includes(action);
}

/** Any action at all — used for the row checkbox. */
export function isSelectableForBulk(item: ReviewQueueItem): boolean {
  return (
    !item.batch_id && !item.view_only && item.is_actionable && item.available_actions.length > 0
  );
}

/**
 * Count and total amount of the SELECTED rows that can actually be approved
 * (DOC-080 §13). A mixed selection must not claim to approve a verify-only row,
 * so only rows whose `available_actions` include `approve` are counted. The
 * total is for the confirmation dialog only — it is never financial authority;
 * the server deducts and returns the real balances.
 */
export function summarizeBulkApprove(
  items: ReviewQueueItem[],
  selectedIds: ReadonlySet<string>,
): { count: number; total: number } {
  let count = 0;
  let total = 0;
  for (const item of items) {
    if (!selectedIds.has(item.id)) continue;
    if (!item.available_actions.includes("approve")) continue;
    count += 1;
    total += Number(item.total_amount ?? 0);
  }
  return { count, total };
}
