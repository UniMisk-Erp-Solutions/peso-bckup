/**
 * Single-expense review actions (DOC-080 §8–§11).
 *
 * Nothing is applied optimistically. The queue and the KPI summary are only
 * invalidated after the server confirms, so a failed verify can never leave a
 * row looking verified — which is the failure mode that would matter most here.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED } from "@/config/reviewQueueServerFeature";
import { reviewQueueInvalidationPrefix } from "@/features/reviewQueueServer/queryKeys";
import { expenseDetailKey } from "@/features/reviewQueueServer/queryKeys";
import {
  approveExpense,
  correctExpense,
  rejectExpense,
  verifyExpense,
  type ActionContext,
} from "../reviewActionService";
import { isSessionFailure, reviewActionMessage } from "../errors";
import type { ActionableExpense, CorrectionInput, ReviewActionKind } from "../types";

export function useReviewExpenseActions(params: {
  organizationId: string | null;
  userId: string | null;
  reviewerRole: string | null;
  onSessionExpired?: () => void;
  /** Called after a confirmed success, so the page can close the detail. */
  onSuccess?: (action: ReviewActionKind, expenseId: string) => void;
}) {
  const { organizationId, userId, reviewerRole, onSessionExpired, onSuccess } = params;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState<ReviewActionKind | null>(null);

  /**
   * Invalidate rather than patch the cache: the server is the authority on the
   * resulting status, tier and assignment, and a hand-patched row would drift.
   * Search, filters and page are preserved because only the data is refetched.
   */
  const invalidate = useCallback(
    async (expenseId: string) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: reviewQueueInvalidationPrefix("review") }),
        queryClient.invalidateQueries({
          queryKey: expenseDetailKey("review", organizationId, expenseId),
        }),
      ]);
    },
    [queryClient, organizationId],
  );

  const ctx: ActionContext = { userId, reviewerRole };

  const run = useCallback(
    async (
      action: ReviewActionKind,
      expense: ActionableExpense,
      fn: () => Promise<string | null | void>,
      successTitle: string,
    ): Promise<boolean> => {
      if (!REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED) return false;
      setPending(action);
      try {
        const status = await fn();
        await invalidate(expense.id);
        toast({
          title: successTitle,
          description:
            typeof status === "string" && status
              ? `Transaction ${expense.transaction_number ?? expense.id} is now ${status}.`
              : undefined,
        });
        onSuccess?.(action, expense.id);
        return true;
      } catch (error) {
        // A stale row is the likeliest cause after a refusal, so refetch even on
        // failure — leaving the old row on screen invites a second attempt.
        await invalidate(expense.id).catch(() => undefined);
        if (isSessionFailure(error)) onSessionExpired?.();
        toast({
          variant: "destructive",
          title: "Action failed",
          description: reviewActionMessage(error),
        });
        return false;
      } finally {
        setPending(null);
      }
    },
    [invalidate, toast, onSessionExpired, onSuccess],
  );

  return {
    pending,
    actionsEnabled: REVIEW_EXPENSES_SERVER_ACTIONS_ENABLED,

    verify: (expense: ActionableExpense, comment?: string) =>
      run(
        "verify",
        expense,
        () => verifyExpense(expense, { ...ctx, comment }),
        "Expense verified",
      ),

    approve: (expense: ActionableExpense, comment?: string) =>
      run(
        "approve",
        expense,
        () => approveExpense(expense, { ...ctx, comment }),
        "Expense approved",
      ),

    reject: (expense: ActionableExpense, reason: string) =>
      run(
        "reject",
        expense,
        () => rejectExpense(expense, ctx, reason),
        "Expense rejected",
      ),

    correct: (expense: ActionableExpense, input: CorrectionInput) =>
      run(
        "correct",
        expense,
        () => correctExpense(expense, ctx, input),
        "Correction applied",
      ),
  };
}
