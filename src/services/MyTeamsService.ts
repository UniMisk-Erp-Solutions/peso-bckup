import { supabase } from "@/integrations/supabase/client";

export type MyTeamMemberOverview = {
  user_id: string;
  name: string;
  email: string;
  employee_id: string;
  balance: number;
  pending_expense_count: number;
  pending_expense_total: number;
  approved_expense_count: number;
  approved_expense_total: number;
};

export type MyTeamOverview = {
  id: string;
  name: string;
  routing_mode: string;
  is_hierarchy_team?: boolean;
  roles_on_team: string[];
  team_leader_user_id: string | null;
  executive_user_id: string | null;
  manager_user_id: string | null;
  team_leader_name: string | null;
  executive_name: string | null;
  manager_name: string | null;
  member_count: number;
  members: MyTeamMemberOverview[];
};

export type TeamExpenseRow = {
  expense_id: string;
  user_id: string;
  employee_name: string;
  employee_id: string;
  employee_email: string;
  title: string;
  total_amount: number;
  status: string;
  created_at: string;
  category_name: string;
};

export async function fetchMyTeamsOverview(
  organizationId: string,
  dateFrom?: Date | null,
  dateTo?: Date | null,
): Promise<MyTeamOverview[]> {
  const { data, error } = await supabase.rpc("list_my_teams_overview", {
    p_organization_id: organizationId,
    p_date_from: dateFrom?.toISOString() ?? null,
    p_date_to: dateTo?.toISOString() ?? null,
  });

  if (error) throw error;

  const payload = data as { teams?: MyTeamOverview[] } | null;
  return payload?.teams ?? [];
}

export async function fetchTeamExpensesForLeader(
  organizationId: string,
  teamId: string,
  options?: {
    statusFilter?: "all" | "pending" | "approved";
    dateFrom?: Date | null;
    dateTo?: Date | null;
    limit?: number;
    offset?: number;
  },
): Promise<TeamExpenseRow[]> {
  const { data, error } = await supabase.rpc("list_team_expenses_for_leader", {
    p_organization_id: organizationId,
    p_team_id: teamId,
    p_status_filter: options?.statusFilter ?? "all",
    p_date_from: options?.dateFrom?.toISOString() ?? null,
    p_date_to: options?.dateTo?.toISOString() ?? null,
    p_limit: options?.limit ?? 500,
    p_offset: options?.offset ?? 0,
  });

  if (error) throw error;
  return (data ?? []) as TeamExpenseRow[];
}
