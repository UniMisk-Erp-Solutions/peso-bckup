/**
 * KPI cards (DOC-080 Phase 14).
 *
 * Every value comes from `scope_summary` in the server response. Nothing here
 * counts React rows, and the numbers describe the COMPLETE reviewer scope — they
 * are unchanged by page, page size and filters, which is why opening page 2
 * cannot move them.
 */

import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatAmount } from "./format";
import type { DebugReviewPage } from "./types";

export function DebugReviewStats({
  page,
  loading,
}: {
  page: DebugReviewPage | null;
  loading: boolean;
}) {
  const { t } = useTranslation("debugReview");
  const s = page?.scope_summary;

  const cards = [
    { key: "assignedToMe", value: s ? String(s.assigned_to_me) : null },
    { key: "pendingReview", value: s ? String(s.pending_review) : null },
    { key: "verified", value: s ? String(s.verified) : null },
    { key: "totalAmount", value: s ? formatAmount(s.total_amount) : null },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="debug-stats">
        {cards.map((c) => (
          <Card key={c.key}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{t(`stats.${c.key}`)}</p>
              {loading && c.value === null ? (
                <Skeleton className="mt-2 h-7 w-20" />
              ) : (
                <p
                  className="mt-1 text-2xl font-semibold tabular-nums"
                  data-testid={`debug-stat-${c.key}`}
                >
                  {c.value ?? "—"}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("stats.scopeNote")}</p>
    </div>
  );
}
