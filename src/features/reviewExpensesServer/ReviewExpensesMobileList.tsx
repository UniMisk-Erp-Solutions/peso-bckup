/**
 * Mobile Review Expenses list.
 *
 * Ported from origin/main:src/components/mobile/MobileReviewExpenseCard.tsx —
 * the same `mobile-review-card` shell, the title + amount top row, the employee
 * identity beneath, and the wrapped context row of status / category / date /
 * Batch / Resubmitted / "Action needed".
 *
 * The previous server list was a generic shadcn `Card` with an `Eye` button,
 * which matched neither main nor the desktop table.
 *
 * Whole-card activation is main's behaviour. Like the desktop table it hands the
 * item to `onOpen` and lets the page branch on `batch_id`, so a batch card
 * navigates to batch review instead of opening the singular dialog.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { formatINR } from "@/lib/format";
import {
  formatEmployeeIdentity,
  identityIssueLabel,
} from "@/features/reviewQueueServer/types";
import type { ReviewQueueItem } from "@/features/reviewQueueServer/types";
import { showsResubmittedInsteadOfStatus } from "./reviewRowPresentation";

export function ReviewExpensesMobileList({
  items,
  selectedIds,
  onToggle,
  onOpen,
  isSelectable,
  actionsEnabled,
  moneyLocale,
}: {
  items: ReviewQueueItem[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (item: ReviewQueueItem) => void;
  isSelectable: (item: ReviewQueueItem) => boolean;
  actionsEnabled: boolean;
  moneyLocale?: string;
}) {
  const { t } = useTranslation("admin");

  return (
    <div className="space-y-2 pb-4" data-testid="review-mobile-list">
      {items.map((item) => {
        const identity = formatEmployeeIdentity(item);
        const issueKey = identityIssueLabel(item.identity_issue);
        const selectable = actionsEnabled && isSelectable(item);
        const date = item.trip_start
          ? new Date(item.trip_start).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })
          : "—";

        return (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(item)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(item);
              }
            }}
            className="mobile-review-card"
            data-testid={`review-mobile-row-${item.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              {selectable && (
                <div
                  className="shrink-0 pt-0.5"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={selectedIds.has(item.id)}
                    onCheckedChange={() => onToggle(item.id)}
                    aria-label={`Select ${identity.primary}`}
                  />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">{item.title}</div>
              </div>
              <div className="text-sm font-bold tabular-nums shrink-0 ml-1">
                {item.total_amount == null ? "—" : formatINR(item.total_amount, moneyLocale)}
              </div>
            </div>

            <div className="mt-1 min-w-0">
              {/* Main's card omits the transaction number; it is kept here
                  because reviewers identify rows by it and the 6174/06174
                  regression test asserts it stays visible. */}
              <div className="font-mono text-[11px] font-semibold text-blue-600">
                {item.transaction_number ?? "-"}
              </div>
              <div className="text-xs font-medium truncate">{identity.primary}</div>
              <div className="text-xs text-muted-foreground truncate">
                {issueKey ? t(`review.identity.${issueKey}`) : (identity.secondary ?? "—")}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {showsResubmittedInsteadOfStatus(item) ? (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 border-amber-400 text-amber-700"
                >
                  {t("review.resubmitted")}
                </Badge>
              ) : (
                <ExpenseStatusWithCorrectionBadge
                  status={item.status}
                  wasReviewerCorrected={item.was_reviewer_corrected}
                  viewerContext="reviewer"
                />
              )}
              {item.category && (
                <span className="text-[10px] text-muted-foreground capitalize">
                  {item.category}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground">{date}</span>
              {item.destination && (
                <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
                  {item.destination}
                </span>
              )}
              {item.batch_id && (
                <Badge
                  // Same server-computed state as the desktop button, so the two
                  // surfaces cannot disagree about whether a batch is finished.
                  variant={item.batch_action_state === "all_done" ? "secondary" : "default"}
                  className={
                    item.batch_action_state === "all_done"
                      ? "text-[10px] px-1.5 py-0"
                      : item.batch_action_state === "partial"
                        ? "text-[10px] px-1.5 py-0 bg-amber-500 hover:bg-amber-600 text-white"
                        : "text-[10px] px-1.5 py-0 bg-blue-600 hover:bg-blue-700 text-white"
                  }
                  data-testid={`review-mobile-batch-badge-${item.id}`}
                  data-batch-state={item.batch_action_state ?? "unknown"}
                >
                  Batch
                </Badge>
              )}
              {item.is_actionable && actionsEnabled && (
                <Badge className="text-[10px] px-1.5 py-0 bg-blue-600">Action needed</Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
