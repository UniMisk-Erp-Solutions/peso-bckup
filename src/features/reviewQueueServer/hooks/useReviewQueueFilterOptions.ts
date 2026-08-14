/**
 * Filter metadata (DOC-080). Server-provided; no V1 fallback.
 *
 * The browser never queries expense_form_field_templates or
 * expense_form_field_option_branches directly — that enumeration is exactly what
 * made V1 slow enough to time out.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchReviewQueueFilterOptions } from "../api";
import { filterOptionsKey, type ReviewQueueScope } from "../queryKeys";

export function useReviewQueueFilterOptions(params: {
  scope: ReviewQueueScope;
  organizationId: string | null;
  userId: string | null;
  enabled: boolean;
}) {
  const { scope, organizationId, userId, enabled } = params;
  const query = useQuery({
    queryKey: filterOptionsKey(scope, organizationId, userId),
    queryFn: () => fetchReviewQueueFilterOptions(organizationId!),
    enabled: enabled && Boolean(organizationId),
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return {
    ...query,
    options: query.data ?? null,
    statuses: query.data?.statuses ?? [],
    categories: query.data?.categories ?? [],
    customFields: query.data?.custom_fields ?? [],
  };
}
