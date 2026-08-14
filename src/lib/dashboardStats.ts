import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { fetchOrgMembershipRolesMap } from "@/lib/orgUsers";

export type ExpenseSummary = {
  totalAmount: number;
  pendingAmount: number;
  approvedAmount: number;
  expenseCount: number;
  pendingApprovals: number;
  pendingApprovalsAmount: number;
};

export type RoleBalanceTotals = {
  employee: number;
  engineer: number;
  cashier: number;
};

type SummaryRow = {
  status: string;
  total_amount: number | null;
  assigned_engineer_id?: string | null;
};

function rollupExpenseRows(rows: SummaryRow[]): ExpenseSummary {
  let totalAmount = 0;
  let pendingAmount = 0;
  let approvedAmount = 0;
  let pendingApprovals = 0;
  let pendingApprovalsAmount = 0;

  for (const row of rows) {
    const amount = Number(row.total_amount || 0);
    totalAmount += amount;
    if (row.status === "submitted" || row.status === "verified") {
      pendingAmount += amount;
    }
    if (row.status === "approved") {
      approvedAmount += amount;
    }
    if (
      row.status === "verified" ||
      (row.status === "submitted" && row.assigned_engineer_id == null)
    ) {
      pendingApprovals += 1;
      pendingApprovalsAmount += amount;
    }
  }

  return {
    totalAmount,
    pendingAmount,
    approvedAmount,
    expenseCount: rows.length,
    pendingApprovals,
    pendingApprovalsAmount,
  };
}

function parseExpenseSummaryRpc(data: unknown): ExpenseSummary | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  return {
    totalAmount: Number(d.total_amount ?? 0),
    pendingAmount: Number(d.pending_amount ?? 0),
    approvedAmount: Number(d.approved_amount ?? 0),
    expenseCount: Number(d.expense_count ?? 0),
    pendingApprovals: Number(d.pending_approvals ?? 0),
    pendingApprovalsAmount: Number(d.pending_approvals_amount ?? 0),
  };
}

function emptyExpenseSummary(): ExpenseSummary {
  return {
    totalAmount: 0,
    pendingAmount: 0,
    approvedAmount: 0,
    expenseCount: 0,
    pendingApprovals: 0,
    pendingApprovalsAmount: 0,
  };
}

export async function fetchDashboardExpenseSummary(
  supabase: SupabaseClient,
  opts: { organizationId?: string | null; userId?: string | null },
): Promise<ExpenseSummary> {
  try {
    const { data, error } = await supabase.rpc("get_dashboard_expense_summary", {
      p_organization_id: opts.organizationId ?? null,
      p_user_id: opts.userId ?? null,
    });
    if (!error && data) {
      const parsed = parseExpenseSummaryRpc(data);
      if (parsed) return parsed;
    }
    if (error) {
      console.warn("get_dashboard_expense_summary RPC:", error.message);
      // Org-wide scans time out on self-hosted Postgres — require the RPC migration.
      if (opts.organizationId) {
        return emptyExpenseSummary();
      }
    }
  } catch (err) {
    console.warn("get_dashboard_expense_summary RPC:", err);
    if (opts.organizationId) {
      return emptyExpenseSummary();
    }
  }

  // User-scoped fallback only (typically far fewer rows than an entire org).
  if (!opts.userId) {
    return emptyExpenseSummary();
  }

  const { data, error } = await supabase
    .from("expenses")
    .select("status, total_amount, assigned_engineer_id")
    .eq("user_id", opts.userId);
  if (error) throw error;
  return rollupExpenseRows((data || []) as SummaryRow[]);
}

export async function fetchEngineerPendingReviewSummary(
  supabase: SupabaseClient,
  engineerId: string,
): Promise<{ count: number; amount: number }> {
  const { data, error } = await supabase
    .from("expenses")
    .select("total_amount")
    .eq("assigned_engineer_id", engineerId)
    .eq("status", "submitted");
  if (error) throw error;
  const rows = data || [];
  return {
    count: rows.length,
    amount: rows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0),
  };
}

/** Pending expense count across teams the caller leads (via list_my_teams_overview RPC). */
export async function fetchMyTeamsPendingSummary(
  organizationId: string,
): Promise<{ count: number; amount: number }> {
  const { data, error } = await supabase.rpc("list_my_teams_overview", {
    p_organization_id: organizationId,
    p_date_from: null,
    p_date_to: null,
  });
  if (error) {
    console.warn("fetchMyTeamsPendingSummary:", error.message);
    return { count: 0, amount: 0 };
  }
  const teams = (data as { teams?: { members?: { pending_expense_count?: number; pending_expense_total?: number }[] }[] } | null)?.teams ?? [];
  let count = 0;
  let amount = 0;
  for (const team of teams) {
    for (const member of team.members ?? []) {
      count += Number(member.pending_expense_count ?? 0);
      amount += Number(member.pending_expense_total ?? 0);
    }
  }
  return { count, amount };
}

export async function fetchOrgRoleBalanceTotals(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<RoleBalanceTotals> {
  const empty = { employee: 0, engineer: 0, cashier: 0 };
  try {
    const { data, error } = await supabase.rpc("get_org_role_balance_totals", {
      p_organization_id: organizationId,
    });
    if (!error && data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      return {
        employee: Number(d.employee ?? 0),
        engineer: Number(d.engineer ?? 0),
        cashier: Number(d.cashier ?? 0),
      };
    }
    if (error) {
      console.warn("get_org_role_balance_totals RPC:", error.message);
    }
  } catch (err) {
    console.warn("get_org_role_balance_totals RPC:", err);
  }

  const { data: profilesData, error: profilesError } = await supabase
    .from("profiles")
    .select("user_id, balance")
    .eq("organization_id", organizationId);
  if (profilesError) throw profilesError;

  if ((profilesData || []).length === 0) return empty;

  const rolesByUserId = await fetchOrgMembershipRolesMap(organizationId);
  const roleByUserId = new Map(Object.entries(rolesByUserId));

  const totals = { ...empty };
  for (const profile of profilesData || []) {
    const role = roleByUserId.get(profile.user_id);
    const balance = Number(profile.balance || 0);
    if (role === "employee") totals.employee += balance;
    else if (role === "engineer") totals.engineer += balance;
    else if (role === "cashier") totals.cashier += balance;
  }
  return totals;
}
