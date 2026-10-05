import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { getMyUnifiedBalanceTimelineV3 } from "@/services/BalanceLedgerService";

/** A unified row: either a real balance_ledger entry, or an expense
 * deduction, exactly as get_my_unified_balance_timeline_v3 returns them.
 * `balance_after` here is the RECONSTRUCTED running balance (server-computed
 * over the full chronological event set, never a stale stored column). */
export type UnifiedBalanceEvent = {
  id: string;
  entry_type: string;
  amount_delta: number;
  balance_after: number;
  effective_at: string;
  note: string | null;
  source_type: string;
  actor_name: string | null;
  /** Present only for expense_deduction rows -- the same field the Expense table shows. */
  transactionNumber: string | null;
};

/**
 * DOC-103 / Additive Credit V3 (2026-09-01). Employee-facing Balance History
 * page. `useEmployeeBalanceHistory` (get_my_balance_transfer_history) stays
 * exactly as-is -- this hook reads get_my_unified_balance_timeline_v3, which:
 *   - positions every expense deduction on its EXPENSE'S business date
 *     (expenses.trip_start), never the approval timestamp;
 *   - reconstructs the running balance server-side over the FULL
 *     chronological event set before pagination, rather than trusting any
 *     stored balance_after value;
 *   - excludes a reversed credit and its reversal from this normal view
 *     (old anchor-engine or new v3 credit-engine reversals alike).
 *
 * `featureEnabled` mirrors the same rollout gate the page itself already
 * enforces (`useEmployeeBalanceHistory`'s `employee_transfer_history` flag).
 * The page's early `if (!featureEnabled) return <Navigate .../>` happens
 * AFTER every hook call (React's rules of hooks), so without this parameter
 * the query would still fire -- and leave a real network trace -- for an
 * employee whose organization has the feature switched off, even though the
 * page never renders anything for them. Passing the flag in keeps this
 * hook's own network behavior honest to the page's actual gate instead of
 * re-deriving a second, independent notion of "on".
 */
export function useEmployeeBalanceLedger(page: number, pageSize: number, featureEnabled: boolean) {
  const { userRole, organizationId, user } = useAuth();

  const enabled = featureEnabled && userRole === "employee" && !!organizationId && !!user?.id;

  const query = useQuery({
    queryKey: ["employeeBalanceLedgerUnifiedV3", organizationId, user?.id, page, pageSize],
    enabled,
    queryFn: async (): Promise<{ rows: UnifiedBalanceEvent[]; totalCount: number }> => {
      const rows = await getMyUnifiedBalanceTimelineV3({
        organizationId: organizationId as string,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });

      const mapped: UnifiedBalanceEvent[] = rows.map((r) => ({
        id: r.event_id,
        entry_type: r.event_type,
        amount_delta: r.amount_delta,
        balance_after: r.calculated_balance_after,
        effective_at: r.effective_at,
        note: r.note,
        source_type: r.source_type,
        actor_name: r.actor_name,
        transactionNumber: r.transaction_number,
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
