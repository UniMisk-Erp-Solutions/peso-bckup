/**
 * KPI reconciliation check (DOC-080).
 *
 * Kept out of the component file so ReviewStatsCards exports a component only.
 *
 * The server already computes `reconciliation_ok`, but this re-derives the
 * arithmetic client-side as well. That is deliberate: a server on an older
 * revision can report `reconciliation_ok: true` simply because the field is
 * absent and defaults, and the whole point of this check is to catch a version
 * skew that would otherwise render two contradictory numbers confidently.
 */

import type { ReviewQueuePage } from "@/features/reviewQueueServer/types";

export function isReconciled(page: ReviewQueuePage | null): boolean {
  const s = page?.scope_summary;
  if (!s) return true;
  return (
    s.reconciliation_ok === true &&
    s.assigned_to_me === s.pending_review + s.completed_review &&
    s.pending_review === s.actionable_now + s.active_not_actionable_now &&
    s.unclassified === 0 &&
    s.self_owned_visible_expenses === 0 &&
    s.visible_without_assignment_reason === 0
  );
}
