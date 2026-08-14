/**
 * Desktop table (DOC-080 Phase 16).
 *
 * Identity is rendered through formatEmployeeIdentity, so an unresolved row shows
 * "Unknown employee / Profile missing" rather than a bare dash — a dash is what
 * made the original defect invisible.
 *
 * The Status / Actions column is sticky right with an opaque background and a
 * left border, so the middle columns scroll under it without bleeding through.
 */

import { useTranslation } from "react-i18next";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { formatAmount, formatDateOnly, formatDateTime } from "./format";
import { formatEmployeeIdentity, identityIssueLabel } from "./types";
import type { DebugReviewQueueItem } from "./types";

const STICKY =
  "sticky right-0 z-20 bg-background border-l shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.25)]";

export function DebugReviewTable({
  items,
  selectedIds,
  onToggle,
  onView,
  actionsEnabled,
}: {
  items: DebugReviewQueueItem[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onView: (id: string) => void;
  actionsEnabled: boolean;
}) {
  const { t } = useTranslation("debugReview");

  return (
    <div className="w-full overflow-x-auto rounded-md border" data-testid="debug-table-scroll">
      <table className="w-full min-w-[1200px] border-collapse text-sm">
        <thead className="bg-muted/50">
          <tr className="[&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th className="w-10">
              <span className="sr-only">{t("table.select")}</span>
            </th>
            <th>{t("table.transactionNumber")}</th>
            <th>{t("table.employee")}</th>
            <th>{t("table.title")}</th>
            <th>{t("table.category")}</th>
            <th>{t("table.destination")}</th>
            <th className="text-right">{t("table.amount")}</th>
            <th className="text-right">{t("table.employeeBalance")}</th>
            <th>{t("table.status")}</th>
            <th>{t("table.expenseDate")}</th>
            <th>{t("table.dateCreated")}</th>
            <th className={cn(STICKY, "bg-muted/50")}>{t("table.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const identity = formatEmployeeIdentity(item);
            const issueKey = identityIssueLabel(item.identity_issue);
            return (
              <tr
                key={item.id}
                className="border-t align-middle [&>td]:px-3 [&>td]:py-2"
                data-testid={`debug-row-${item.id}`}
              >
                <td>
                  <Checkbox
                    checked={selectedIds.has(item.id)}
                    onCheckedChange={() => onToggle(item.id)}
                    aria-label={t("table.select")}
                  />
                </td>
                <td className="whitespace-nowrap font-mono text-xs">
                  {item.transaction_number ?? "—"}
                </td>
                <td className="max-w-[220px]">
                  <p className="truncate font-medium" data-testid={`debug-row-employee-${item.id}`}>
                    {identity.primary}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {/* Never a bare dash: an identity issue is more useful. */}
                    {issueKey ? t(`identity.${issueKey}`) : (identity.secondary ?? "")}
                  </p>
                </td>
                <td className="max-w-[240px]">
                  <p className="truncate">{item.title}</p>
                  <div className="mt-0.5 flex gap-1">
                    {item.is_resubmitted && (
                      <Badge variant="outline" className="h-5 px-1 text-[10px]">
                        {t("table.resubmitted")}
                      </Badge>
                    )}
                    {item.was_reviewer_corrected && (
                      <Badge variant="outline" className="h-5 px-1 text-[10px]">
                        {t("table.corrected")}
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap">{item.category ?? "—"}</td>
                <td className="max-w-[160px] truncate">{item.destination ?? "—"}</td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {formatAmount(item.total_amount)}
                </td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {formatAmount(item.current_balance)}
                </td>
                <td>
                  <StatusBadge status={item.status} />
                </td>
                <td className="whitespace-nowrap">{formatDateOnly(item.trip_start)}</td>
                <td className="whitespace-nowrap">{formatDateTime(item.created_at)}</td>
                <td className={STICKY}>
                  <div className="flex items-center justify-end gap-2">
                    {item.view_only && (
                      <Badge variant="outline" className="h-5 px-1 text-[10px]">
                        {t("table.viewOnly")}
                      </Badge>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`debug-view-${item.id}`}
                      onClick={() => onView(item.id)}
                    >
                      <Eye className="mr-1 h-3.5 w-3.5" />
                      {t("table.view")}
                    </Button>
                    {/* Read-only page: rendered disabled purely so a reviewer can
                        confirm the row IS actionable without being able to act. */}
                    {item.is_actionable && !actionsEnabled && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled
                        data-testid={`debug-action-disabled-${item.id}`}
                      >
                        {t("table.disabled")}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
