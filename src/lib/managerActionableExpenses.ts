import type { SupabaseClient } from "@supabase/supabase-js";

/** Expense IDs where executive verified and advanced toward manager (audit trail).
 *
 * Fetches all tier_advanced logs for the org in a SINGLE query (no per-expense
 * IN chunks) then filters by the provided expenseIds in JS.  The chunked approach
 * was issuing 10–15 parallel audit_log queries each taking 3–5 s with many
 * expenses — this replaces all of them with one fast lookup.
 */
export async function fetchExecutiveHandoffExpenseIds(
  supabase: SupabaseClient,
  organizationId: string,
  expenseIds: string[],
): Promise<Set<string>> {
  if (expenseIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from("audit_logs")
    .select("expense_id, comment")
    .eq("organization_id", organizationId)
    .eq("action", "tier_advanced");

  if (error) {
    console.warn("fetchExecutiveHandoffExpenseIds:", error.message);
    return new Set();
  }

  const expenseIdSet = new Set(expenseIds);
  const ids = new Set<string>();
  for (const row of data ?? []) {
    const id = row.expense_id as string | undefined;
    if (!id || !expenseIdSet.has(id)) continue;
    const comment = String(row.comment ?? "").toLowerCase();
    if (
      comment.includes("advanced to engineer") ||
      (comment.includes("verified at executive") && comment.includes("advanced to"))
    ) {
      ids.add(id);
    }
  }
  return ids;
}

export type ManagerQueueExpense = {
  id?: string;
  status: string;
  approval_tier?: string | null;
  managerQueueReady?: boolean;
};

export type ManagerQueueReadyOptions = {
  teamLeaderTierEnabled?: boolean;
  executiveTierEnabled?: boolean;
};

const MANAGER_ACTIONABLE_STATUSES = [
  "submitted",
  "edited",
  "under_review",
  "level_1_verified",
  "level_2_verified",
] as const;

function isManagerActionableStatus(status: string): boolean {
  return (MANAGER_ACTIONABLE_STATUSES as readonly string[]).includes(status);
}

/** True when expense tier is disabled on the org — routing skipped that step. */
export function isSkippedHierarchyTier(
  approvalTier: string | null | undefined,
  hierarchyEnabled: boolean,
  options?: ManagerQueueReadyOptions,
): boolean {
  if (!hierarchyEnabled || !approvalTier) return false;
  if (approvalTier === "team_leader") {
    return options?.teamLeaderTierEnabled === false;
  }
  if (approvalTier === "executive") {
    return options?.executiveTierEnabled === false;
  }
  return false;
}

export function computeManagerQueueReady(
  expense: ManagerQueueExpense,
  executiveHandoffIds: Set<string>,
  hierarchyEnabled: boolean,
  options?: ManagerQueueReadyOptions,
): boolean {
  const terminal = ["verified", "approved", "rejected"];
  if (terminal.includes(expense.status)) return false;

  if (expense.status === "level_2_verified") return true;

  if (expense.approval_tier === "engineer") {
    return isManagerActionableStatus(expense.status);
  }

  if (expense.id && executiveHandoffIds.has(expense.id)) {
    return true;
  }

  if (
    isSkippedHierarchyTier(expense.approval_tier, hierarchyEnabled, options) &&
    isManagerActionableStatus(expense.status)
  ) {
    return true;
  }

  if (!hierarchyEnabled && isManagerActionableStatus(expense.status)) {
    return true;
  }

  return false;
}

export async function isUserTeamManagerForExpense(
  supabase: SupabaseClient,
  organizationId: string,
  managerUserId: string,
  expenseUserId: string,
  teamsEnabled = true,
): Promise<boolean> {
  if (!teamsEnabled) return false;
  const { data: teams, error: teamsError } = await supabase
    .from("teams")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("manager_user_id", managerUserId);

  if (teamsError || !teams?.length) return false;

  const teamIds = teams.map((t) => t.id as string);
  const { data: members, error: membersError } = await supabase
    .from("team_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .in("team_id", teamIds)
    .eq("user_id", expenseUserId)
    .limit(1);

  if (membersError) return false;
  return (members?.length ?? 0) > 0;
}
