/** Whether the expense owner may edit their own expense (single or batch line). Matches owner UPDATE RLS (submitted/rejected/draft). */
export function canOwnerEditExpenseStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  if (status === "edited") return false;
  if (status === "approved" || status === "paid") return false;
  return status === "submitted" || status === "rejected" || status === "draft";
}

/**
 * Whether the expense owner may hard-delete their own expense. Matches the
 * owner DELETE RLS policy ("Users can delete their own draft expenses",
 * supabase/migrations/20260909140000_protect_non_draft_expense_history.sql):
 * draft only. Once an expense is submitted it enters the review/audit
 * workflow and the server permanently refuses a hard delete — the UI must
 * not offer an action the server will reject. See DOC-128: the server-side
 * delete_draft_expense_v1 RPC additionally refuses a draft that was ever
 * submitted (one reached by Withdraw), so this client-side check is
 * necessary but not sufficient — it only controls what the menu offers.
 *
 * Superseded for the "Delete" UI action by canOwnerTrashExpenseStatus
 * (DOC-129, the 30-day Recycle Bin) — kept only because delete_draft_
 * expense_v1 itself is retained, unused, for a possible future
 * service_role-only maintenance need; do not wire this back into the UI.
 */
export function canOwnerHardDeleteExpenseStatus(status: string | null | undefined): boolean {
  return status === "draft";
}

/**
 * Whether the expense owner may move their own expense to the Recycle Bin
 * (DOC-129). Matches trash_expense_v1's own status check: any draft is
 * eligible, whether it was never submitted or reached draft via Withdraw —
 * the "previously submitted and withdrawn" permanent-delete refusal from
 * DOC-128 no longer applies to this action, because trashing never erases
 * anything. A submitted expense is never directly trashable; it must be
 * withdrawn first.
 */
export function canOwnerTrashExpenseStatus(status: string | null | undefined): boolean {
  return status === "draft";
}

/**
 * Whether the expense owner may withdraw (recall to draft) their own
 * submitted expense, before anyone has reviewed it. Matches
 * withdraw_submitted_expense_v1's own status check (DOC-128).
 */
export function canOwnerWithdrawExpenseStatus(status: string | null | undefined): boolean {
  return status === "submitted";
}
