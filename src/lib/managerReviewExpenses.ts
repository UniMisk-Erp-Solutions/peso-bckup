import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeManagerQueueReady,
  fetchExecutiveHandoffExpenseIds,
} from "@/lib/managerActionableExpenses";
import { chunkArray } from "@/lib/supabaseInQuery";

export type ManagerReviewFetchParams = {
  organizationId: string;
  managerUserId: string;
  hierarchyEnabled: boolean;
  teamsEnabled?: boolean;
  teamLeaderTierEnabled: boolean;
  executiveTierEnabled: boolean;
  includeTeamLeaderReports: boolean;
  includeExecutiveReports: boolean;
};

export const MANAGER_REVIEW_STATUSES = [
  "submitted",
  "verified",
  "approved",
  "rejected",
  "edited",
  "under_review",
  "level_1_verified",
  "level_2_verified",
] as const;

function mergeExpenseRows(
  batches: Record<string, unknown>[][],
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const batch of batches) {
    for (const row of batch) {
      const id = row.id as string | undefined;
      if (id) byId.set(id, row);
    }
  }
  return [...byId.values()];
}

/**
 * Resolve user IDs whose expenses a manager may see in review (by reporting line).
 *
 * Walks the full reporting hierarchy via BFS so that:
 *   Manager → Executive → Team Leader → Employee
 * is fully traversed, not just the single direct-report level.
 * Max practical depth is 4, so this is at most 4 DB round-trips.
 */
export async function fetchManagerSubordinateUserIds(
  supabase: SupabaseClient,
  params: ManagerReviewFetchParams,
): Promise<string[]> {
  const allDescendantIds = new Set<string>();
  let frontier = [params.managerUserId];

  // BFS — each iteration fetches one generation of direct reports
  while (frontier.length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id")
      .eq("organization_id", params.organizationId)
      .in("reporting_engineer_id", frontier);

    if (error) throw error;

    const nextFrontier: string[] = [];
    for (const p of data ?? []) {
      const uid = p.user_id as string;
      if (!allDescendantIds.has(uid)) {
        allDescendantIds.add(uid);
        nextFrontier.push(uid);
      }
    }
    frontier = nextFrontier;
  }

  if (allDescendantIds.size === 0) return [];

  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("user_id, role")
    .eq("organization_id", params.organizationId)
    .in("user_id", [...allDescendantIds])
    .eq("is_active", true);

  if (membershipsError) throw membershipsError;

  const allowedRoles = new Set<string>(["employee"]);
  if (params.includeTeamLeaderReports && params.teamLeaderTierEnabled) {
    allowedRoles.add("team_leader");
  }
  if (params.includeExecutiveReports && params.executiveTierEnabled) {
    allowedRoles.add("executive");
  }

  return (memberships || [])
    .filter((m) => allowedRoles.has(String(m.role)))
    .map((m) => m.user_id as string);
}

/** User IDs on teams where this manager is teams.manager_user_id. */
export async function fetchTeamMemberUserIdsForManager(
  supabase: SupabaseClient,
  organizationId: string,
  managerUserId: string,
): Promise<string[]> {
  const { data: teams, error: teamsError } = await supabase
    .from("teams")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("manager_user_id", managerUserId);

  if (teamsError) throw teamsError;
  const teamIds = (teams ?? []).map((t) => t.id as string);
  if (teamIds.length === 0) return [];

  const { data: members, error: membersError } = await supabase
    .from("team_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .in("team_id", teamIds);

  if (membersError) throw membersError;
  return [...new Set((members ?? []).map((m) => m.user_id as string))];
}

export type FetchManagerReviewerExpensesParams = {
  organizationId: string;
  managerUserId: string;
  dateFilter?: Date | null;
  hierarchyEnabled: boolean;
  teamsEnabled?: boolean;
  teamLeaderTierEnabled: boolean;
  executiveTierEnabled: boolean;
  includeTeamLeaderReports: boolean;
  includeExecutiveReports: boolean;
  /** When set, cap results to this many rows (most-recent first). Omit to fetch all. */
  fetchLimit?: number;
};

async function fetchExpensesByFilter(
  supabase: SupabaseClient,
  organizationId: string,
  dateFilter: Date | null | undefined,
  applyFilter: (query: ReturnType<SupabaseClient["from"]>) => ReturnType<SupabaseClient["from"]>,
  fetchLimit?: number,
): Promise<Record<string, unknown>[]> {
  let query = supabase
    .from("expenses")
    .select("*")
    .eq("organization_id", organizationId)
    .in("status", [...MANAGER_REVIEW_STATUSES]);

  query = applyFilter(query) as typeof query;

  if (dateFilter) {
    query = query.gte("created_at", dateFilter.toISOString());
  }

  if (fetchLimit) {
    query = query.limit(fetchLimit) as typeof query;
  }

  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

async function tryFetchExpensesByFilter(
  supabase: SupabaseClient,
  organizationId: string,
  dateFilter: Date | null | undefined,
  applyFilter: (query: ReturnType<SupabaseClient["from"]>) => ReturnType<SupabaseClient["from"]>,
  label: string,
  fetchLimit?: number,
): Promise<Record<string, unknown>[]> {
  try {
    return await fetchExpensesByFilter(supabase, organizationId, dateFilter, applyFilter, fetchLimit);
  } catch (error) {
    console.warn(`manager review fallback query failed (${label}):`, error);
    return [];
  }
}

const COMPLETED_MANAGER_STATUSES = new Set(["verified", "approved", "rejected"]);

/** Include pending manager work and completed items (approved/verified/rejected) in Assigned list. */
function isRowInManagerReviewQueue(
  row: Record<string, unknown>,
  executiveHandoffIds: Set<string>,
  params: FetchManagerReviewerExpensesParams,
): boolean {
  const status = String(row.status ?? "");
  if (COMPLETED_MANAGER_STATUSES.has(status)) return true;
  return computeManagerQueueReady(
    {
      id: row.id as string | undefined,
      status,
      approval_tier: (row.approval_tier as string | null) ?? null,
    },
    executiveHandoffIds,
    params.hierarchyEnabled,
    {
      teamLeaderTierEnabled: params.teamLeaderTierEnabled,
      executiveTierEnabled: params.executiveTierEnabled,
    },
  );
}

/** Primary fetch for manager / engineer review queue (RPC + merged simple queries). */
export async function fetchManagerReviewerExpenses(
  supabase: SupabaseClient,
  params: FetchManagerReviewerExpensesParams,
): Promise<Record<string, unknown>[]> {
  const { organizationId, managerUserId, dateFilter, fetchLimit } = params;
  const fetchParams: ManagerReviewFetchParams = {
    organizationId,
    managerUserId,
    hierarchyEnabled: params.hierarchyEnabled,
    teamLeaderTierEnabled: params.teamLeaderTierEnabled,
    executiveTierEnabled: params.executiveTierEnabled,
    includeTeamLeaderReports: params.includeTeamLeaderReports,
    includeExecutiveReports: params.includeExecutiveReports,
  };

  let pendingQuery = supabase.rpc("list_manager_pending_expenses", {
    p_organization_id: organizationId,
  });
  let reviewerQuery = supabase.rpc("list_manager_reviewer_expenses", {
    p_organization_id: organizationId,
  });
  if (fetchLimit) {
    pendingQuery = pendingQuery.range(0, fetchLimit - 1) as typeof pendingQuery;
    reviewerQuery = reviewerQuery.range(0, fetchLimit - 1) as typeof reviewerQuery;
  }

  // Round 1: fire RPCs, subordinate/team ID lookups, and the three fallback queries
  // that don't depend on those IDs — all in parallel (was 3 sequential await rounds).
  const [
    pendingRpc,
    reviewerRpc,
    subordinateIds,
    teamMemberIds,
    assignedEngineerRows,
    assignedReviewerRows,
    level2VerifiedRows,
  ] = await Promise.all([
    pendingQuery,
    reviewerQuery,
    fetchManagerSubordinateUserIds(supabase, fetchParams).catch(() => [] as string[]),
    params.teamsEnabled
      ? fetchTeamMemberUserIdsForManager(supabase, organizationId, managerUserId).catch(
          () => [] as string[],
        )
      : Promise.resolve([] as string[]),
    tryFetchExpensesByFilter(
      supabase,
      organizationId,
      dateFilter,
      (query) => query.eq("assigned_engineer_id", managerUserId),
      "assigned_engineer",
      fetchLimit,
    ),
    tryFetchExpensesByFilter(
      supabase,
      organizationId,
      dateFilter,
      (query) => query.eq("assigned_reviewer_id", managerUserId),
      "assigned_reviewer",
      fetchLimit,
    ),
    // level_2_verified only exists when the executive tier is enabled; skip the
    // broad org-wide scan otherwise to avoid Postgres statement timeouts.
    params.executiveTierEnabled
      ? tryFetchExpensesByFilter(
          supabase,
          organizationId,
          dateFilter,
          (query) => query.eq("status", "level_2_verified"),
          "level_2_verified",
          fetchLimit,
        )
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  let rpcRows: Record<string, unknown>[] = [];
  if (pendingRpc.error) {
    if (import.meta.env.DEV) {
      console.error("Manager pending expense fetch failed:", {
        organizationId,
        managerUserId,
        message: pendingRpc.error.message,
      });
    } else {
      console.error("Manager pending expense fetch failed:", pendingRpc.error.message);
    }
  } else {
    rpcRows = (pendingRpc.data ?? []) as Record<string, unknown>[];
  }

  if (reviewerRpc.error) {
    if (import.meta.env.DEV) {
      console.warn("Manager reviewer expense fetch failed:", reviewerRpc.error.message);
    }
  } else {
    rpcRows = mergeExpenseRows([
      rpcRows,
      (reviewerRpc.data ?? []) as Record<string, unknown>[],
    ]);
  }

  // Round 2: subordinate/team-member batch queries (depend on IDs from Round 1).
  const [subordinateBatchRows, teamMemberBatchRows] = await Promise.all([
    subordinateIds.length > 0
      ? Promise.all(
          chunkArray(subordinateIds).map((batch) =>
            tryFetchExpensesByFilter(
              supabase,
              organizationId,
              dateFilter,
              (query) => query.in("user_id", batch),
              "subordinates",
              fetchLimit,
            ),
          ),
        ).then((batches) => batches.flat())
      : Promise.resolve([] as Record<string, unknown>[]),
    teamMemberIds.length > 0
      ? Promise.all(
          chunkArray(teamMemberIds).map((batch) =>
            tryFetchExpensesByFilter(
              supabase,
              organizationId,
              dateFilter,
              (query) => query.in("user_id", batch),
              "team_members",
              fetchLimit,
            ),
          ),
        ).then((batches) => batches.flat())
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  let rows = mergeExpenseRows([
    rpcRows,
    assignedEngineerRows,
    assignedReviewerRows,
    level2VerifiedRows,
    subordinateBatchRows,
    teamMemberBatchRows,
  ]);

  const expenseIds = rows
    .map((r) => r.id as string | undefined)
    .filter((id): id is string => Boolean(id));
  const executiveHandoffIds = await fetchExecutiveHandoffExpenseIds(
    supabase,
    organizationId,
    expenseIds,
  );

  const queueReadyOptions = {
    teamLeaderTierEnabled: params.teamLeaderTierEnabled,
    executiveTierEnabled: params.executiveTierEnabled,
  };

  // Do NOT filter out rows that aren't in the manager's action queue.
  // Visibility (can see) is separate from actionability (can act).
  // Subordinate expenses at an earlier tier are visible but not yet actionable;
  // the manager_queue_ready flag tells the UI whether to show action buttons.

  rows = rows.map((row) => ({
    ...row,
    manager_queue_ready: computeManagerQueueReady(
      {
        id: row.id as string,
        status: String(row.status ?? ""),
        approval_tier: (row.approval_tier as string | null) ?? null,
      },
      executiveHandoffIds,
      params.hierarchyEnabled,
      queueReadyOptions,
    ),
  }));

  if (dateFilter) {
    const minTs = dateFilter.toISOString();
    rows = rows.filter((row) => {
      const created = row.created_at as string | undefined;
      return created ? created >= minTs : true;
    });
  }

  rows.sort((a, b) => {
    const ta = new Date(String(a.updated_at ?? a.created_at ?? 0)).getTime();
    const tb = new Date(String(b.updated_at ?? b.created_at ?? 0)).getTime();
    return tb - ta;
  });

  if (fetchLimit && rows.length > fetchLimit) {
    rows = rows.slice(0, fetchLimit);
  }

  return rows;
}
