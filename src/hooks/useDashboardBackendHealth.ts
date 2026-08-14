import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  DashboardBackendHealth,
  INITIAL_HEALTH,
  normalizeBackendHealthRpc,
} from "@/lib/backendHealth";

const QUERY_KEY = ["dashboard-backend-health"] as const;

/**
 * Diagnostic-only hook for the Dashboard's backend health chip.
 *
 * Policy:
 *  - First fetch fires immediately when the Dashboard mounts.
 *  - Refreshes every 60 seconds while the tab is visible.
 *  - Pauses when the tab is hidden (refetchIntervalInBackground: false).
 *  - Refetches on window focus.
 *  - Single in-flight request at a time (deduplicated by React Query).
 *  - Cleans up on unmount (React Query handles this).
 *  - NEVER activates maintenance, blocks routes, or writes Edge Config.
 */
export function useDashboardBackendHealth(): DashboardBackendHealth {
  const { data } = useQuery<DashboardBackendHealth>({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<DashboardBackendHealth> => {
      const start = performance.now();
      const { data, error } = await supabase.rpc("get_backend_health");
      const elapsedMs = Math.round(performance.now() - start);
      return normalizeBackendHealthRpc(data, error, elapsedMs);
    },
    staleTime: 45_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
    retryDelay: 5_000,
    // Return INITIAL_HEALTH while first fetch is in flight
    placeholderData: INITIAL_HEALTH,
  });

  return data ?? INITIAL_HEALTH;
}
