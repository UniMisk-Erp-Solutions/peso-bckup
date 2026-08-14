/** Whether the expense owner may edit their own expense (single or batch line). Matches owner UPDATE RLS (submitted/rejected/draft). */
export function canOwnerEditExpenseStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  if (status === "edited") return false;
  if (status === "approved" || status === "paid") return false;
  return status === "submitted" || status === "rejected" || status === "draft";
}
