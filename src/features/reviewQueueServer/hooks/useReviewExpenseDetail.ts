/**
 * Expense detail (DOC-080). One RPC per opened expense.
 *
 * Visibility is re-checked server-side, so an unauthorized id fails even if the
 * request is crafted by hand. There is no second enrichment request — the RPC
 * already carries employee, custom fields, attachments, timeline, corrections
 * and actionability.
 */

import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { fetchReviewExpenseDetail } from "../api";
import { expenseDetailKey, type ReviewQueueScope } from "../queryKeys";

export function useReviewExpenseDetail(params: {
  scope: ReviewQueueScope;
  organizationId: string | null;
  expenseId: string | null;
  enabled: boolean;
}) {
  const { scope, organizationId, expenseId, enabled } = params;
  const requestCount = useRef(0);

  const query = useQuery({
    queryKey: expenseDetailKey(scope, organizationId, expenseId),
    queryFn: async () => {
      requestCount.current += 1;
      return fetchReviewExpenseDetail(organizationId!, expenseId!);
    },
    enabled: enabled && Boolean(organizationId) && Boolean(expenseId),
    staleTime: 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return { ...query, detail: query.data ?? null, getRequestCount: () => requestCount.current };
}
