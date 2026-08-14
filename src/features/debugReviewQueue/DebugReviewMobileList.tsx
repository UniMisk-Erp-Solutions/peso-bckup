/**
 * Mobile card list (DOC-080 Phase 17).
 *
 * Written against the debug item type directly — it does not reuse the V1 mobile
 * component, which would drag V1 data shapes and fetch logic back in.
 */

import { useTranslation } from "react-i18next";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/StatusBadge";
import { formatAmount, formatDateOnly } from "./format";
import { formatEmployeeIdentity, identityIssueLabel } from "./types";
import type { DebugReviewQueueItem } from "./types";

export function DebugReviewMobileList({
  items,
  onView,
}: {
  items: DebugReviewQueueItem[];
  onView: (id: string) => void;
}) {
  const { t } = useTranslation("debugReview");

  return (
    <div className="space-y-3" data-testid="debug-mobile-list">
      {items.map((item) => {
        const identity = formatEmployeeIdentity(item);
        const issueKey = identityIssueLabel(item.identity_issue);
        return (
          <Card key={item.id} data-testid={`debug-mobile-row-${item.id}`}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-xs text-muted-foreground">
                    {item.transaction_number ?? "—"}
                  </p>
                  <p className="truncate font-medium">{identity.primary}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {issueKey ? t(`identity.${issueKey}`) : (identity.secondary ?? "")}
                  </p>
                </div>
                <StatusBadge status={item.status} />
              </div>

              <p className="truncate text-sm">{item.title}</p>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {item.destination && <span>{item.destination}</span>}
                <span>{formatDateOnly(item.trip_start)}</span>
                {item.view_only && (
                  <Badge variant="outline" className="h-5 px-1 text-[10px]">
                    {t("table.viewOnly")}
                  </Badge>
                )}
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="font-semibold tabular-nums">
                  {formatAmount(item.total_amount)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`debug-mobile-view-${item.id}`}
                  onClick={() => onView(item.id)}
                >
                  <Eye className="mr-1 h-3.5 w-3.5" />
                  {t("table.view")}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
