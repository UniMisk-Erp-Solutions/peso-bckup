import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

/**
 * Employee-safe balance credit row, exactly as returned by
 * `get_my_balance_transfer_history`. Nothing here identifies another user, a
 * bank account, or the internal transfer-date edit trail.
 */
export type BalanceCreditRow = {
  id: string;
  amount: number;
  transferred_at: string;
  /** 'cash' | 'bank_transfer' — nullable so legacy rows are never guessed at. */
  payment_mode: string | null;
  transfer_type: string | null;
  credited_by_name: string | null;
  source_bank_name: string | null;
};

export type EmployeeBalanceHistoryResult = {
  rows: BalanceCreditRow[];
  totalCount: number;
};

const EMPTY: EmployeeBalanceHistoryResult = { rows: [], totalCount: 0 };

/**
 * Server-paginated balance credit history for the signed-in employee.
 *
 * The query is the client half of a two-sided gate: it stays disabled unless the
 * user is an employee, the organization has `employee_transfer_history` on, and
 * auth/org context has resolved. The RPC enforces the same rules independently,
 * so a hand-typed route or a direct RPC call cannot bypass the flag.
 *
 * The query key carries organizationId and user id, so switching organizations
 * or users starts a fresh cache entry rather than briefly showing the previous
 * organization's credits.
 */
export function useEmployeeBalanceHistory(page: number, pageSize: number) {
  const { user, userRole, organizationId, hasOrganizationFeature } = useAuth();

  const featureEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.employee_transfer_history,
  );
  const enabled =
    userRole === "employee" && featureEnabled && !!organizationId && !!user?.id;

  const query = useQuery({
    queryKey: [
      "employeeBalanceHistory",
      organizationId,
      user?.id,
      page,
      pageSize,
    ],
    enabled,
    queryFn: async (): Promise<EmployeeBalanceHistoryResult> => {
      const { data, error } = await supabase.rpc(
        "get_my_balance_transfer_history",
        {
          p_organization_id: organizationId as string,
          p_limit: pageSize,
          p_offset: (page - 1) * pageSize,
        },
      );
      if (error) throw error;

      const rows = (data ?? []) as (BalanceCreditRow & { total_count: number })[];
      return {
        rows: rows.map(({ total_count: _ignored, ...row }) => row),
        totalCount: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
      };
    },
  });

  return {
    featureEnabled,
    enabled,
    // While the query is disabled the cached rows must not leak through — a
    // feature switched off mid-session should empty the page immediately.
    data: enabled ? (query.data ?? EMPTY) : EMPTY,
    isLoading: enabled && query.isPending,
    isError: enabled && query.isError,
    isFetching: enabled && query.isFetching,
    refetch: query.refetch,
  };
}
