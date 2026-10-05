import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { fetchOrgMembershipRolesMap } from "@/lib/orgUsers";
import { expenseMonthBounds, type ExpenseMonthValue } from "@/lib/expenseMonthFilter";

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
    .eq("user_id", opts.userId)
    .is("deleted_at", null); // DOC-129: mirrors get_dashboard_expense_summary's own filter
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
    .eq("status", "submitted")
    .is("deleted_at", null); // DOC-129
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

// ---------------------------------------------------------------------------
// Dashboard Month filter: ONE server-side snapshot (get_dashboard_stats_v2)
// ---------------------------------------------------------------------------

/**
 * Whether Current Balance is the live balance or a month-end balance. "live"
 * covers All time AND a month that has not finished yet (current month) --
 * the server never invents a future month-end balance.
 */
export type DashboardBalanceBasis = "live" | "month_end";

export type DashboardStatsV2 = {
  totalAmount: number;
  expenseCount: number;
  pendingAmount: number;
  approvedAmount: number;
  pendingApprovals: number;
  pendingApprovalsAmount: number;
  /** null for roles that have no review queue (everyone but engineers). */
  pendingReviews: number | null;
  pendingReviewsAmount: number | null;
  currentBalance: number;
  /** null unless the caller is an admin. */
  roleBalanceTotals: RoleBalanceTotals | null;
  balanceBasis: DashboardBalanceBasis;
  /** "YYYY-MM-DD" last day of the selected month when basis is month_end, else null. */
  balanceAsOf: string | null;
};

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export function parseDashboardStatsV2(data: unknown): DashboardStatsV2 | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.current_balance === undefined || d.total_amount === undefined) return null;
  const rt = d.role_balance_totals as Record<string, unknown> | null | undefined;
  const scope = (d.scope ?? {}) as Record<string, unknown>;
  return {
    totalAmount: Number(d.total_amount ?? 0),
    expenseCount: Number(d.expense_count ?? 0),
    pendingAmount: Number(d.pending_amount ?? 0),
    approvedAmount: Number(d.approved_amount ?? 0),
    pendingApprovals: Number(d.pending_approvals ?? 0),
    pendingApprovalsAmount: Number(d.pending_approvals_amount ?? 0),
    pendingReviews: numOrNull(d.pending_reviews),
    pendingReviewsAmount: numOrNull(d.pending_reviews_amount),
    currentBalance: Number(d.current_balance ?? 0),
    roleBalanceTotals: rt
      ? { employee: Number(rt.employee ?? 0), engineer: Number(rt.engineer ?? 0), cashier: Number(rt.cashier ?? 0) }
      : null,
    balanceBasis: scope.balance_basis === "month_end" ? "month_end" : "live",
    balanceAsOf: typeof scope.balance_as_of === "string" ? scope.balance_as_of : null,
  };
}

/** RPC bounds for a Dashboard month value: both null for "all" (today's behaviour, exactly). */
export function dashboardMonthRpcBounds(month: ExpenseMonthValue): {
  p_month_from: string | null;
  p_month_to_exclusive: string | null;
} {
  const b = expenseMonthBounds(month);
  return { p_month_from: b?.from ?? null, p_month_to_exclusive: b?.toExclusive ?? null };
}

/**
 * One request, one consistent snapshot: every card for the selected month
 * comes from the same response, so they can never disagree about the month.
 * The caller's identity is taken from the session on the server -- never
 * from an argument here.
 */
export async function fetchDashboardStatsV2(
  organizationId: string,
  month: ExpenseMonthValue,
  signal?: AbortSignal,
): Promise<DashboardStatsV2> {
  // get_dashboard_stats_v2 is not in the generated Supabase types yet.
  const client = supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }> & {
      abortSignal: (s: AbortSignal) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    };
  };
  let q: PromiseLike<{ data: unknown; error: { message: string } | null }> = client.rpc("get_dashboard_stats_v2", {
    p_organization_id: organizationId,
    ...dashboardMonthRpcBounds(month),
  });
  // Cancel the in-flight request when superseded (newest month wins).
  if (signal) {
    q = (q as ReturnType<typeof client.rpc>).abortSignal(signal);
  }
  const { data, error } = await q;
  if (error) throw error;
  const parsed = parseDashboardStatsV2(data);
  if (!parsed) throw new Error("get_dashboard_stats_v2 returned an unexpected payload");
  return parsed;
}
