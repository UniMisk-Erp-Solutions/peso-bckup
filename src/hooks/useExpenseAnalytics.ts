import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { analyticsKeys } from "@/lib/analytics/analyticsQueryKeys";
import {
  computeAnalytics,
  computePreviousPeriod,
  resolveGranularity,
  type AnalyticsExpenseRow,
  type AnalyticsProfile,
  type AnalyticsResult,
  type DateBasis,
  type Granularity,
} from "@/lib/analytics/expenseAnalytics";

const PAGE_SIZE = 1000;

export interface AnalyticsFilters {
  dateFrom: Date;
  dateTo: Date;
  dateBasis: DateBasis;
  granularity: Granularity;
  compareEnabled: boolean;
  statusFilter: string[];
  categoryFilter: string[];
  employeeFilter: string;
  destinationFilter: string;
}

export interface AnalyticsQueryMeta {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  dataUpdatedAt: number | null;
  totalFetched: number;
  resolvedGranularity: "daily" | "weekly" | "monthly";
}

export interface UseExpenseAnalyticsReturn {
  result: AnalyticsResult | null;
  meta: AnalyticsQueryMeta;
  refetch: () => void;
}

interface FetchArgs {
  organizationId: string;
  userRole: string;
  userId: string | undefined;
  filters: AnalyticsFilters;
}

async function fetchAnalyticsData(args: FetchArgs): Promise<{
  expenses: AnalyticsExpenseRow[];
  prevExpenses: AnalyticsExpenseRow[] | null;
  profiles: AnalyticsProfile[];
}> {
  const { organizationId, userRole, userId, filters } = args;
  const { dateFrom, dateTo, dateBasis, compareEnabled } = filters;

  const dateField = dateBasis === "expense_date" ? "trip_start" : "created_at";
  const fromISO = dateFrom.toISOString();
  const toISO = dateTo.toISOString();

  const MINIMAL_SELECT =
    "id,organization_id,user_id,title,transaction_number,status,total_amount,category,destination,trip_start,trip_end,created_at,updated_at,batch_id,approval_tier,assigned_engineer_id,assigned_reviewer_id";

  async function fetchPage(
    from: string,
    to: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<AnalyticsExpenseRow[]> {
    const rows: AnalyticsExpenseRow[] = [];
    let offset = 0;
    let total: number | null = null;

    while (true) {
      let query = supabase
        .from("expenses")
        .select(MINIMAL_SELECT, offset === 0 ? { count: "exact" } : undefined)
        .eq("organization_id", organizationId)
        .neq("status", "draft")
        .gte(dateField, from)
        .lte(dateField, to)
        .range(offset, offset + PAGE_SIZE - 1);

      if (userRole !== "admin") {
        if (!userId) break;
        query = query.eq("user_id", userId);
      }

      if (filters.statusFilter.length > 0) {
        query = query.in("status", filters.statusFilter);
      }
      if (filters.categoryFilter.length > 0) {
        query = query.in("category", filters.categoryFilter);
      }
      if (filters.employeeFilter && userRole === "admin") {
        query = query.eq("user_id", filters.employeeFilter);
      }
      if (filters.destinationFilter) {
        if (filters.destinationFilter === "__unspecified__") {
          query = query.or("destination.is.null,destination.eq.");
        } else {
          query = query.eq("destination", filters.destinationFilter);
        }
      }

      const { data, error, count } = await query;
      if (error) throw error;

      if (offset === 0 && count !== null) {
        total = count;
      }

      const chunk = (data ?? []) as AnalyticsExpenseRow[];
      rows.push(...chunk);

      if (onProgress && total !== null) {
        onProgress(rows.length, total);
      }

      if (chunk.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return rows;
  }

  const expenses = await fetchPage(fromISO, toISO);

  let prevExpenses: AnalyticsExpenseRow[] | null = null;
  if (compareEnabled) {
    const { prevFrom, prevTo } = computePreviousPeriod(dateFrom, dateTo);
    prevExpenses = await fetchPage(prevFrom.toISOString(), prevTo.toISOString());
  }

  let profiles: AnalyticsProfile[] = [];
  if (userRole === "admin" && expenses.length > 0) {
    const userIds = Array.from(new Set(expenses.map((e) => e.user_id)));
    const chunks: string[][] = [];
    for (let i = 0; i < userIds.length; i += 200) {
      chunks.push(userIds.slice(i, i + 200));
    }
    const results = await Promise.all(
      chunks.map((chunk) =>
        supabase
          .from("profiles")
          .select("user_id, name, employee_id")
          .in("user_id", chunk),
      ),
    );
    for (const r of results) {
      if (r.data) {
        profiles.push(
          ...(r.data as Array<{ user_id: string; name: string; employee_id?: string | null }>),
        );
      }
    }
  }

  return { expenses, prevExpenses, profiles };
}

export function useExpenseAnalytics(
  organizationId: string | null | undefined,
  userRole: string,
  userId: string | undefined,
  filters: AnalyticsFilters,
): UseExpenseAnalyticsReturn {
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolvedGranularity = resolveGranularity(
    filters.granularity,
    filters.dateFrom,
    filters.dateTo,
  );

  const userScopeKey =
    userRole === "admin" ? "organization" : (userId ?? "none");

  const queryKey = analyticsKeys.detail(
    organizationId ?? "",
    userScopeKey,
    filters.dateBasis,
    filters.dateFrom.toISOString(),
    filters.dateTo.toISOString(),
    filters.compareEnabled,
    filters.granularity,
    filters.statusFilter,
    filters.categoryFilter,
    filters.employeeFilter,
    filters.destinationFilter,
  );

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!organizationId) return null;
      const { expenses, prevExpenses, profiles } = await fetchAnalyticsData({
        organizationId,
        userRole,
        userId,
        filters,
      });
      return computeAnalytics(
        expenses,
        prevExpenses,
        profiles,
        filters.dateFrom,
        filters.dateTo,
        resolvedGranularity,
        filters.dateBasis,
      );
    },
    enabled: !!organizationId,
    staleTime: 0,
    gcTime: 30 * 60 * 1000,
    placeholderData: keepPreviousData,
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
  });

  // Realtime invalidation — one subscription, debounced 1 s
  useEffect(() => {
    if (!organizationId) return;

    const channel = supabase
      .channel(`analytics-expenses-${organizationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "expenses",
          filter: `organization_id=eq.${organizationId}`,
        },
        () => {
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            queryClient.invalidateQueries({
              queryKey: analyticsKeys.all(organizationId),
            });
          }, 1000);
        },
      )
      .subscribe();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      supabase.removeChannel(channel);
    };
  }, [organizationId, queryClient]);

  return {
    result: query.data ?? null,
    meta: {
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      isError: query.isError,
      error: query.error,
      dataUpdatedAt: query.dataUpdatedAt ?? null,
      totalFetched: query.data
        ? query.data.kpis.totalCount
        : 0,
      resolvedGranularity,
    },
    refetch: () => query.refetch(),
  };
}
