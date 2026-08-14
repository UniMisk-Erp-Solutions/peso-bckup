/**
 * The queue page query (DOC-080).
 *
 * The query key is the contract for what "the same page" means, and it contains
 * only SUBMITTED values — draft search text is deliberately absent. React
 * Query's key-scoped caching then provides stale-response protection for free:
 * a response for an old key can never be written into a newer one.
 */

import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { fetchReviewQueuePage } from "../api";
import {
  reviewQueuePageKey,
  type ReviewQueuePageKeyInput,
  type ReviewQueueScope,
} from "../queryKeys";
import type { ReviewQueuePage } from "../types";

export function useReviewQueuePage(
  scope: ReviewQueueScope,
  input: ReviewQueuePageKeyInput & { enabled: boolean },
) {
  const { enabled, ...i } = input;
  const requestCount = useRef(0);
  const lastDurationMs = useRef<number | null>(null);

  const query = useQuery<ReviewQueuePage>({
    queryKey: reviewQueuePageKey(scope, i),
    queryFn: async () => {
      requestCount.current += 1;
      const started = Date.now();
      try {
        return await fetchReviewQueuePage({
          organizationId: i.organizationId!,
          pageSize: i.pageSize,
          cursor: i.cursor,
          sort: i.sort,
          employeeUserId: i.employeeUserId,
          generalSearch: i.generalSearch,
          statuses: i.statuses.length ? i.statuses : null,
          categories: i.categories.length ? i.categories : null,
          dateFrom: i.dateFrom,
          dateTo: i.dateTo,
          actionableOnly: i.actionableOnly,
          customFilters: i.customFilters,
        });
      } finally {
        lastDurationMs.current = Date.now() - started;
      }
    },
    enabled: enabled && Boolean(i.organizationId),
    // Keeps the previous page visible while the next one loads instead of
    // flashing an empty table.
    placeholderData: (prev) => prev,
    staleTime: 30 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return {
    ...query,
    page: query.data ?? null,
    items: query.data?.items ?? [],
    getRequestCount: () => requestCount.current,
    getLastDurationMs: () => lastDurationMs.current,
  };
}
