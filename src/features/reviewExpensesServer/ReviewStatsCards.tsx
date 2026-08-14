/**
 * The four KPI cards (DOC-080).
 *
 * Markup, icons, grid and typography are the existing EngineerReview ones so the
 * page looks unchanged. The MEANING is what the 2026-08-02 audit corrected:
 *
 *   Assigned to Me  every genuinely assigned row (7,582 in the audit)
 *   Pending Review  every NON-TERMINAL assigned row (7,574) — this now includes
 *                   level_1_verified and level_2_verified, which are mid-workflow
 *   Completed       every TERMINAL row (8) — verified/approved/rejected/paid
 *   Total Amount    unchanged
 *
 * The old third card said "Verified 558", which was 520 level_2 + 36 level_1 + 2
 * actually verified. Counting mid-workflow rows as finished work is what left
 * 1,746 expenses belonging to no card, and it also double-counted the 36
 * level_1_verified rows against Pending. Both are gone.
 *
 * Which summary is described depends on context (DOC-080 sec 12). With no
 * content filter the cards read `scope_summary` - the reviewer's whole assigned
 * scope. The moment anything narrows the population, including a selected
 * employee, they read `filtered_summary`, so the cards and the table always
 * describe the same rows. Previously they always read `scope_summary`, which is
 * why selecting employee 6174 left them showing organization-wide totals next to
 * that employee's expenses.
 *
 * Both come from the server, aggregated before the cursor and the page limit;
 * nothing here counts React rows, which is why opening page 2 cannot move them.
 */

import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle, Clock, Coins, Receipt } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR } from "@/lib/format";
import type { ReviewQueuePage } from "@/features/reviewQueueServer/types";
import { isReconciled } from "./reconciliation";
import { chooseSummary, filteredSummaryMatchesTotal, type SummaryContext } from "./summarySource";

export function ReviewStatsCards({
  page,
  loading,
  moneyLocale,
  filtered = false,
  context = { kind: "global" },
}: {
  page: ReviewQueuePage | null;
  loading: boolean;
  moneyLocale?: string;
  /** True when any content filter narrows the table's population. */
  filtered?: boolean;
  /** What the numbers describe, shown above the cards. */
  context?: SummaryContext;
}) {
  const { t } = useTranslation("admin");
  const choice = chooseSummary(page, filtered);
  const s = choice.state === "ready" ? choice.summary : null;

  const value = (v: string | null) =>
    v === null ? (
      // Covers loading AND an unsupported server. "0" is never printed for a
      // number the server did not send.
      <Skeleton className="h-8 w-20" />
    ) : (
      <div className="text-2xl font-bold">{v}</div>
    );

  const showPaid = (s?.paid ?? 0) > 0;
  // Global reconciliation, plus the filtered invariant when it applies.
  const reconciled =
    isReconciled(page) &&
    filteredSummaryMatchesTotal(page) &&
    (choice.state !== "ready" || !choice.filtered || choice.summary.reconciliation_ok);

  return (
    <div className="space-y-2">
      {/* Without this a reviewer cannot tell whether the numbers are theirs or
          one employee's - the two differ by three orders of magnitude here. */}
      {context.kind !== "global" && (
        <p className="text-xs text-muted-foreground" data-testid="review-stats-context">
          {context.kind === "employee"
            ? `${t("review.metricsFor")} ${context.name}${
                context.employeeId ? ` · ${t("review.employeeIdShort")} ${context.employeeId}` : ""
              }`
            : t("review.metricsForSearch")}
        </p>
      )}

      {/* An older server omits filtered_summary. Rendering zeros would read as
          real counts, so the cards say what is wrong instead. */}
      {choice.state === "unsupported" && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="review-filtered-summary-unsupported"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("review.filteredSummaryUnsupported")}</span>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4" data-testid="review-stats">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("review.assignedToMe")}</CardTitle>
            <Receipt className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent data-testid="review-stat-assigned">
            {value(s ? String(s.assigned_to_me) : null)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("review.pendingReview")}</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent data-testid="review-stat-pending">
            {value(s ? String(s.pending_review) : null)}
            {s && (
              // Actionable-now is a SUBSET of pending, not a synonym for it.
              // Conflating the two is what hid 1,775 team_leader-tier rows.
              <p className="mt-1 text-xs text-muted-foreground" data-testid="review-stat-actionable">
                {t("review.actionableNow", { count: s.actionable_now })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("review.completed")}</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent data-testid="review-stat-completed">
            {value(s ? String(s.completed_review) : null)}
            {s && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="review-stat-completed-breakdown">
                {t("review.completedBreakdown", {
                  verified: s.verified,
                  approved: s.approved,
                  rejected: s.rejected,
                })}
                {showPaid ? ` · ${t("review.paidCount", { count: s.paid })}` : ""}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("review.totalAmount")}</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent data-testid="review-stat-amount">
            {value(s ? formatINR(s.total_amount, moneyLocale) : null)}
          </CardContent>
        </Card>
      </div>

      {/* Dev/Preview only. In Production a reconciliation failure must not be
          shown to an ordinary reviewer as raw diagnostics — but it does gate
          actions, which the page handles separately. */}
      {import.meta.env.DEV && s && !reconciled && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="review-reconciliation-warning"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("review.reconciliationWarning")}</span>
        </div>
      )}
    </div>
  );
}
