import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { getMyUnifiedBalanceHistory } from "@/services/BalanceLedgerService";

/** A unified row: either a real balance_ledger entry, or an expense
 * deduction, exactly as get_my_unified_balance_history_v1 returns them. */
export type UnifiedBalanceEvent = {
  id: string;
  entry_type: string;
  amount_delta: number;
  balance_after: number;
  effective_at: string;
  note: string | null;
  source_type: string;
  actor_name: string | null;
};

/**
 * DOC-103. Employee-facing Balance History page. `useEmployeeBalanceHistory`
 * (get_my_balance_transfer_history) stays exactly as-is -- this hook reads
 * the single get_my_unified_balance_history_v1 RPC, which UNIONs
 * balance_ledger and expense_balance_deductions server-side BEFORE
 * ordering/paginating, so page boundaries are always correct across the
 * combined timeline (a client-side two-source merge cannot guarantee that
 * once both sources have enough history).
 */
export function useEmployeeBalanceLedger(page: number, pageSize: number) {
  const { userRole, organizationId, user } = useAuth();

  const enabled = userRole === "employee" && !!organizationId && !!user?.id;

  const query = useQuery({
    queryKey: ["employeeBalanceLedgerUnified", organizationId, user?.id, page, pageSize],
    enabled,
    queryFn: async (): Promise<{ rows: UnifiedBalanceEvent[]; totalCount: number }> => {
      const rows = await getMyUnifiedBalanceHistory({
        organizationId: organizationId as string,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });

      const mapped: UnifiedBalanceEvent[] = rows.map((r) => ({
        id: r.event_id,
        entry_type: r.event_type,
        amount_delta: r.amount_delta,
        balance_after: r.balance_after,
        effective_at: r.effective_at,
        note: r.note,
        source_type: r.source_type,
        actor_name: r.actor_name,
      }));

      const totalCount = rows.length > 0 ? Number(rows[0]!.total_count) : 0;

      return { rows: mapped, totalCount };
    },
  });

  return {
    enabled,
    data: enabled ? (query.data ?? { rows: [], totalCount: 0 }) : { rows: [], totalCount: 0 },
    isLoading: enabled && query.isPending,
    isError: enabled && query.isError,
    isFetching: enabled && query.isFetching,
    refetch: query.refetch,
  };
}
