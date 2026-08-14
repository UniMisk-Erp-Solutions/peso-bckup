/**
 * Desktop Review Expenses table.
 *
 * The presentation is ported from origin/main:src/pages/EngineerReview.tsx
 * (the table at ~L2478-3080) — column order and widths, the resizable headers,
 * the blue mono transaction number, the stacked employee cell with its
 * mobile-only lines, the violet Batch badge, the green/red balance with its
 * insufficient-balance hint, the status badge with its queue hint, and the
 * sticky Status/Actions column.
 *
 * The data source is the server queue item, not main's client-assembled
 * `Expense`. That is the whole point: same table, different pipeline.
 *
 * The row action is where main's behaviour was previously lost. Main branches on
 * `batch_id` — a batch line renders `Review batch` and NAVIGATES; only a
 * singular row opens the review dialog. The previous server table rendered one
 * generic `View / Review` for every row and opened the singular modal for both,
 * which is the defect this file exists to fix. Both branches call `onOpen(item)`
 * and the page decides; the table never fetches anything itself.
 */

import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { useResizableColumns } from "@/hooks/useResizableColumns";
import { getRoleLabel } from "@/lib/approvalHierarchy";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { formatINR, formatCreatedDateTime } from "@/lib/format";
import {
  formatEmployeeIdentity,
  identityIssueLabel,
} from "@/features/reviewQueueServer/types";
import type { ReviewQueueItem } from "@/features/reviewQueueServer/types";
import {
  balanceIsShort,
  batchButtonStyle,
  queueHint,
  reviewButtonLabel,
  reviewButtonStyle,
  showsResubmittedInsteadOfStatus,
} from "./reviewRowPresentation";

// Verbatim from main.
const STICKY_HEAD =
  "sticky right-0 z-30 min-w-[150px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right";
const STICKY_CELL =
  "sticky right-0 z-20 min-w-[150px] border-l bg-background group-hover:bg-muted text-right";

// Main's defaults, under main's storage key so a reviewer's saved widths carry
// over from the legacy page instead of resetting.
const COLUMN_DEFAULTS = {
  txn: 90,
  employee: 220,
  title: 130,
  category: 120,
  destination: 140,
  amount: 110,
  balance: 110,
  status: 120,
  expense_date: 130,
  date_created: 130,
};

function expenseDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function ReviewExpensesTable({
  items,
  selectedIds,
  onToggle,
  onSelectAll,
  onOpen,
  isSelectable,
  actionsEnabled,
  moneyLocale,
}: {
  items: ReviewQueueItem[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: (checked: boolean) => void;
  /** Receives the whole item so the page can branch on batch_id. */
  onOpen: (item: ReviewQueueItem) => void;
  isSelectable: (item: ReviewQueueItem) => boolean;
  actionsEnabled: boolean;
  moneyLocale?: string;
}) {
  const { t } = useTranslation("admin");
  const { labels: roleLabels } = useOrganizationRoleLabels();
  const { colWidth, startResize } = useResizableColumns(
    "pw_engineer_review_cols",
    COLUMN_DEFAULTS,
  );

  const selectable = items.filter(isSelectable);
  const allSelected =
    selectable.length > 0 && selectable.every((e) => selectedIds.has(e.id));

  const sized = (key: keyof typeof COLUMN_DEFAULTS) => ({
    width: colWidth(key),
    minWidth: colWidth(key),
  });

  const handle = (key: keyof typeof COLUMN_DEFAULTS) => (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${key} column`}
      onMouseDown={(e) => startResize(key, e)}
      className="absolute right-0 top-0 h-full w-1 cursor-col-resize opacity-0 group-hover/th:opacity-100 bg-border"
    />
  );

  return (
    <div
      data-testid="review-scroll-container"
      className="relative w-full overflow-x-auto -mx-4 sm:mx-0"
    >
      <Table noScrollWrapper className="min-w-max">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10 px-2">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(checked) => onSelectAll(!!checked)}
                disabled={selectable.length === 0}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden whitespace-nowrap"
              style={sized("txn")}
            >
              Txn #{handle("txn")}
            </TableHead>
            <TableHead className="relative group/th overflow-hidden" style={sized("employee")}>
              Employee / Employee ID{handle("employee")}
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden hidden sm:table-cell"
              style={sized("title")}
            >
              Title{handle("title")}
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden hidden md:table-cell"
              style={sized("category")}
            >
              Category{handle("category")}
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden hidden sm:table-cell"
              style={sized("destination")}
            >
              Destination{handle("destination")}
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden whitespace-nowrap"
              style={sized("amount")}
            >
              Amount{handle("amount")}
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden hidden md:table-cell"
              style={sized("balance")}
            >
              {t("review.employeeBalance")}
              {handle("balance")}
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden hidden sm:table-cell"
              style={sized("status")}
            >
              Status{handle("status")}
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden whitespace-nowrap text-right pr-2 sm:pr-4 hidden sm:table-cell"
              style={sized("expense_date")}
            >
              Expense Date{handle("expense_date")}
            </TableHead>
            <TableHead
              className="relative group/th overflow-hidden whitespace-nowrap text-right pr-2 sm:pr-4 hidden md:table-cell"
              style={sized("date_created")}
            >
              Date Created{handle("date_created")}
            </TableHead>
            <TableHead data-testid="review-actions-header" className={STICKY_HEAD}>
              Status / Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const identity = formatEmployeeIdentity(item);
            const issueKey = identityIssueLabel(item.identity_issue);
            const short = balanceIsShort(item);
            const hint = queueHint(item, (tier) => getRoleLabel(tier, roleLabels));
            const showResubmitted = showsResubmittedInsteadOfStatus(item);
            const statusCell = showResubmitted ? (
              <Badge
                variant="outline"
                className="text-xs bg-blue-50 text-blue-700 border-blue-200"
              >
                {t("review.resubmitted")}
              </Badge>
            ) : (
              <ExpenseStatusWithCorrectionBadge
                status={item.status}
                wasReviewerCorrected={item.was_reviewer_corrected}
                viewerContext="reviewer"
              />
            );

            return (
              <TableRow key={item.id} className="group" data-testid={`review-row-${item.id}`}>
                <TableCell className="w-10 px-2" onClick={(e) => e.stopPropagation()}>
                  {isSelectable(item) && (
                    <Checkbox
                      checked={selectedIds.has(item.id)}
                      onCheckedChange={() => onToggle(item.id)}
                      aria-label={`Select ${identity.primary}`}
                    />
                  )}
                </TableCell>

                <TableCell className="text-xs sm:text-sm font-mono font-semibold text-blue-600 whitespace-nowrap">
                  {item.transaction_number ?? "-"}
                </TableCell>

                <TableCell
                  className="text-xs sm:text-sm"
                  data-testid={`review-row-employee-${item.id}`}
                >
                  <div>
                    <div className="font-medium truncate">{identity.primary}</div>
                    <div className="text-xs truncate font-mono font-medium text-foreground">
                      {/* Never a bare dash — an identity issue is more useful. */}
                      {issueKey ? t(`review.identity.${issueKey}`) : (identity.secondary ?? "—")}
                    </div>
                    {/* Columns hidden at this breakpoint are restacked here, as in main. */}
                    <div
                      className={`text-xs sm:hidden mt-1 font-medium ${
                        short ? "text-red-600" : "text-green-600"
                      }`}
                    >
                      {t("review.employeeBalance")}: {formatINR(item.current_balance, moneyLocale)}
                    </div>
                    <div className="font-medium text-xs sm:text-sm mt-1 line-clamp-1 break-words sm:hidden">
                      {item.title}
                    </div>
                    {item.batch_id && (
                      <Badge
                        variant="outline"
                        className="text-xs mt-1 bg-violet-50 text-violet-700 border-violet-200"
                        data-testid={`review-batch-badge-${item.id}`}
                      >
                        Batch
                      </Badge>
                    )}
                    <div className="text-xs text-muted-foreground sm:hidden mt-1">
                      {item.destination ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground sm:hidden mt-1">
                      Expense: {expenseDate(item.trip_start)}
                    </div>
                    <div className="text-xs text-muted-foreground sm:hidden">
                      {formatCreatedDateTime(item.created_at)}
                    </div>
                  </div>
                </TableCell>

                <TableCell className="font-medium text-xs sm:text-sm hidden sm:table-cell">
                  <div className="line-clamp-2 break-words">{item.title}</div>
                  {item.was_reviewer_corrected && (
                    <Badge variant="outline" className="h-5 px-1 text-[10px] mt-1">
                      {t("review.corrected")}
                    </Badge>
                  )}
                </TableCell>

                <TableCell className="text-xs sm:text-sm hidden md:table-cell capitalize">
                  {item.category ?? "—"}
                </TableCell>

                <TableCell
                  className="text-xs sm:text-sm truncate hidden sm:table-cell max-w-[140px]"
                  title={item.destination ?? undefined}
                >
                  {item.destination ?? "—"}
                </TableCell>

                <TableCell className="whitespace-nowrap text-xs sm:text-sm font-medium">
                  {item.total_amount == null ? "—" : formatINR(item.total_amount, moneyLocale)}
                </TableCell>

                <TableCell className="text-xs sm:text-sm hidden md:table-cell">
                  <div
                    className={`font-medium whitespace-nowrap ${
                      short ? "text-red-600" : "text-green-600"
                    }`}
                  >
                    {formatINR(item.current_balance, moneyLocale)}
                  </div>
                  {short && (
                    <div className="text-xs text-red-500 whitespace-nowrap">
                      {t("review.insufficientBalance")}
                    </div>
                  )}
                </TableCell>

                <TableCell className="hidden sm:table-cell">
                  {showResubmitted ? (
                    statusCell
                  ) : (
                    <div className="space-y-1">
                      {statusCell}
                      {hint ? (
                        <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>
                      ) : null}
                    </div>
                  )}
                </TableCell>

                <TableCell className="whitespace-nowrap text-xs sm:text-sm text-right pr-2 sm:pr-4 hidden sm:table-cell">
                  {expenseDate(item.trip_start)}
                </TableCell>

                <TableCell className="whitespace-nowrap text-xs sm:text-sm text-right pr-2 sm:pr-4 hidden md:table-cell">
                  {formatCreatedDateTime(item.created_at)}
                </TableCell>

                <TableCell data-testid="review-actions-cell" className={STICKY_CELL}>
                  <div className="flex flex-col sm:flex-row items-end gap-2 sm:gap-0">
                    {/* Status is a hidden column below sm, so it repeats here. */}
                    <div className="sm:hidden mb-2">{statusCell}</div>
                    <div className="flex justify-end shrink-0">
                      {item.batch_id ? (
                        (() => {
                          // Colour comes from the server's whole-batch state, so
                          // grey genuinely means "nothing left for you here".
                          const b = batchButtonStyle(item.batch_action_state);
                          return (
                            <Button
                              size="sm"
                              variant={b.variant}
                              className={b.className}
                              data-testid={`review-batch-${item.id}`}
                              data-batch-state={item.batch_action_state ?? "unknown"}
                              onClick={() => onOpen(item)}
                            >
                              {b.label}
                            </Button>
                          );
                        })()
                      ) : (
                        <Button
                          size="sm"
                          variant={reviewButtonStyle(item).variant}
                          className={reviewButtonStyle(item).className}
                          data-testid={`review-view-${item.id}`}
                          onClick={() => onOpen(item)}
                        >
                          {actionsEnabled ? reviewButtonLabel(item) : "View"}
                        </Button>
                      )}
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
