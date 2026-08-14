import type { SupabaseClient } from "@supabase/supabase-js";
import type { PostgrestFilterBuilder } from "@supabase/postgrest-js";
import { fetchMyTeamsOverview } from "@/services/MyTeamsService";

export const TEAM_REPORTS_LEADER_ROLES = new Set([
  "admin",
  "engineer",
  "team_leader",
  "executive",
]);

/** All user IDs across teams the current user leads (My Teams RPC). */
export async function fetchTeamMemberUserIds(organizationId: string): Promise<string[]> {
  const teams = await fetchMyTeamsOverview(organizationId, null, null);
  const ids = new Set<string>();
  for (const team of teams) {
    for (const member of team.members) {
      if (member.user_id) ids.add(member.user_id);
    }
  }
  return [...ids];
}

type ExpenseRow = Record<string, unknown> & { user_id?: string; created_at?: string; trip_start?: string };

function sortExpenseRows(rows: ExpenseRow[], sortBy: "created_at" | "trip_start"): ExpenseRow[] {
  return [...rows].sort((a, b) => {
    const aKey = String(a[sortBy] ?? "");
    const bKey = String(b[sortBy] ?? "");
    return bKey.localeCompare(aKey);
  });
}

export interface TeamExpensesRpcOptions {
  supabase: SupabaseClient;
  organizationId: string;
  /** Status values to include. null/undefined = all statuses. */
  statuses?: string[];
  /** Category substring filter (ilike). */
  category?: string;
  /** trip_start lower bound, ISO date string e.g. "2025-01-01". */
  tripStartFrom?: string;
  /** trip_start upper bound, ISO date string e.g. "2025-12-31". */
  tripStartTo?: string;
}

/**
 * Run an expenses query scoped to My Teams members when teamScoped is true.
 *
 * When teamScoped AND rpcOptions are provided, uses the SECURITY DEFINER
 * get_team_expenses_for_members RPC instead of the expenses table directly.
 * This bypasses RLS — which cannot efficiently evaluate per-row recursive
 * hierarchy checks — and passes user IDs in the request body (no URL limit).
 *
 * When not team-scoped (or rpcOptions is not provided), falls back to
 * the buildQuery callback path (direct table access with RLS).
 */
export async function fetchTeamScopedExpenses<T extends ExpenseRow>(
  options: {
    teamScoped: boolean;
    teamUserIds: string[];
    selectedEmployee: string;
    sortBy?: "created_at" | "trip_start";
    /** Required when rpcOptions is not provided or teamScoped is false. */
    buildQuery: (
      applyUserFilter: (
        q: PostgrestFilterBuilder<any, any, any[], unknown, unknown>,
      ) => PostgrestFilterBuilder<any, any, any[], unknown, unknown>,
    ) => PostgrestFilterBuilder<any, any, any[], unknown, unknown>;
    /**
     * When provided and teamScoped is true, the RPC path is used for ALL
     * team-scoped fetches (both single-employee and all-employee).
     * Security is enforced upstream: teamUserIds comes from list_my_teams_overview
     * which is SECURITY DEFINER and already scopes to the viewer's teams.
     */
    rpcOptions?: TeamExpensesRpcOptions;
  },
): Promise<T[]> {
  const { teamScoped, teamUserIds, selectedEmployee, sortBy = "created_at", buildQuery, rpcOptions } = options;

  if (teamScoped && selectedEmployee !== "all") {
    const allowedIds = new Set(teamUserIds);
    if (allowedIds.size > 0 && !allowedIds.has(selectedEmployee)) return [];
  }

  if (teamScoped && selectedEmployee === "all" && teamUserIds.length === 0) {
    return [];
  }

  // ── Team-scoped RPC path ──────────────────────────────────────────────────
  // Uses get_team_expenses_for_members (SECURITY DEFINER) to bypass RLS.
  // RLS cannot evaluate recursive hierarchy checks per-row without timing out.
  if (teamScoped && rpcOptions) {
    const userIds =
      selectedEmployee === "all"
        ? teamUserIds
        : [selectedEmployee];

    const { data, error } = await rpcOptions.supabase.rpc(
      "get_team_expenses_for_members",
      {
        p_organization_id: rpcOptions.organizationId,
        p_user_ids: userIds,
        p_statuses: rpcOptions.statuses ?? null,
        p_category: rpcOptions.category ?? null,
        p_trip_start_from: rpcOptions.tripStartFrom ?? null,
        p_trip_start_to: rpcOptions.tripStartTo ?? null,
        p_sort_by: sortBy,
        p_limit: 2000,
      },
    );
    if (error) throw error;
    return (data ?? []) as T[];
  }

  // ── Non-team-scoped path (or team-scoped without rpcOptions) ─────────────
  // Falls back to direct table access via buildQuery callback.
  const applyUserFilter = (q: PostgrestFilterBuilder<any, any, any[], unknown, unknown>) => {
    if (selectedEmployee !== "all") {
      return q.eq("user_id", selectedEmployee);
    }
    return q;
  };

  if (!teamScoped || selectedEmployee !== "all") {
    const query = buildQuery(applyUserFilter);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as T[];
    if (teamScoped && selectedEmployee === "all") {
      const allowedIds = new Set(teamUserIds);
      return sortExpenseRows(
        rows.filter((r) => allowedIds.has(String(r.user_id ?? ""))),
        sortBy,
      ) as T[];
    }
    return rows;
  }

  // Org-wide fetch with in-memory filter (legacy non-RPC team path).
  const noopFilter = (q: PostgrestFilterBuilder<any, any, any[], unknown, unknown>) => q;
  const query = buildQuery(noopFilter);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as T[];
  const allowedIds = new Set(teamUserIds);

  return sortExpenseRows(
    rows.filter((r) => allowedIds.has(String(r.user_id ?? ""))),
    sortBy,
  ) as T[];
}
