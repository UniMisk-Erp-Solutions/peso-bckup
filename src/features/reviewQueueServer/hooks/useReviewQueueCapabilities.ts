/**
 * Capability probe (DOC-080). Gates every other query.
 *
 * `ready` is computed server-side from to_regprocedure, so a partially applied
 * migration reports false and the page refuses to load queue data rather than
 * showing a half-working surface.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchReviewQueueCapabilities } from "../api";
import { capabilitiesKey, type ReviewQueueScope } from "../queryKeys";

export function useReviewQueueCapabilities(scope: ReviewQueueScope, enabled: boolean) {
  const query = useQuery({
    queryKey: capabilitiesKey(scope),
    queryFn: fetchReviewQueueCapabilities,
    enabled,
    // Contract shape cannot change inside a session without a redeploy.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const missingFunctions = query.data
    ? Object.entries(query.data.functions)
        .filter(([, present]) => !present)
        .map(([name]) => name)
    : [];

  return {
    ...query,
    capabilities: query.data ?? null,
    isReady: query.data?.ready === true,
    missingFunctions,
  };
}
