/**
 * Bulk review actions (DOC-080 §12).
 *
 * A partial failure is reported as a partial failure. The legacy page counted
 * successes and swallowed the errors; here every row carries its own result so
 * "verified 12, 3 failed" can name which three.
 *
 * Ineligible rows are SKIPPED rather than attempted, so a batch line or a
 * wrong-tier row never reaches the server just to be refused.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED } from "@/config/reviewQueueServerFeature";
import { reviewQueueInvalidationPrefix } from "@/features/reviewQueueServer/queryKeys";
import { eligibleForBulk } from "../actionEligibility";
import { runBulkAction, type ActionContext } from "../reviewActionService";
import type { ActionableExpense, BulkActionSummary, ReviewActionKind } from "../types";

export function useBulkReviewActions(params: {
  userId: string | null;
  reviewerRole: string | null;
  onComplete?: (summary: BulkActionSummary) => void;
}) {
  const { userId, reviewerRole, onComplete } = params;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<BulkActionSummary | null>(null);
  /** {completed, total} while a bulk run is in flight, else null. Drives "Approving 7 of 18…". */
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);

  const run = useCallback(
    async (
      action: Exclude<ReviewActionKind, "correct">,
      selected: ActionableExpense[],
      reason?: string,
    ): Promise<BulkActionSummary | null> => {
      if (!REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED) return null;
      if (selected.length === 0) return null;

      setBusy(true);
      try {
        const { eligible, skipped } = eligibleForBulk(selected, action, userId);
        const ctx: ActionContext = { userId, reviewerRole };
        setProgress({ completed: 0, total: eligible.length });
        const results = await runBulkAction(eligible, action, ctx, reason, {
          onProgress: (completed, total) => setProgress({ completed, total }),
        });

        const full: BulkActionSummary = {
          action,
          totalSelected: selected.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          skipped: skipped.length,
          results: [
            ...results,
            ...skipped.map((e) => ({
              expenseId: e.id,
              transactionNumber: e.transaction_number,
              action,
              ok: false,
              skipped: true,
              error: "Not eligible for this action",
            })),
          ],
        };

        await queryClient.invalidateQueries({
          queryKey: reviewQueueInvalidationPrefix("review"),
        });

        setSummary(full);
        onComplete?.(full);

        // Never announce a clean run when something failed.
        const parts = [`${full.succeeded} succeeded`];
        if (full.failed) parts.push(`${full.failed} failed`);
        if (full.skipped) parts.push(`${full.skipped} skipped`);
        toast({
          variant: full.failed > 0 ? "destructive" : undefined,
          title: `Bulk ${action}: ${parts.join(", ")}`,
          description:
            full.failed > 0
              ? full.results
                  .filter((r) => !r.ok && !r.skipped)
                  .slice(0, 3)
                  .map((r) => `${r.transactionNumber ?? r.expenseId}: ${r.error}`)
                  .join(" · ")
              : undefined,
        });
        return full;
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [queryClient, toast, userId, reviewerRole, onComplete],
  );

  return {
    busy,
    progress,
    summary,
    actionsEnabled: REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED,
    bulkVerify: (rows: ActionableExpense[]) => run("verify", rows),
    bulkApprove: (rows: ActionableExpense[]) => run("approve", rows),
    bulkReject: (rows: ActionableExpense[], reason: string) => run("reject", rows, reason),
  };
}
