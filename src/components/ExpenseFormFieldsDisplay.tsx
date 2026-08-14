import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fetchExpenseFormFieldDisplayGrouped,
  type FormFieldDisplayContext,
} from "@/lib/fetchExpenseFormFieldDisplay";
import type { ExpenseFormFieldDisplayNode } from "@/lib/expenseFieldDisplayModel";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { cn } from "@/lib/utils";

type ExpenseFormFieldsDisplayProps = {
  expenseId: string;
  organizationId: string;
  context?: FormFieldDisplayContext;
  className?: string;
  /** Wrap in a Card (detail page style). Default: inline list for review dialogs. */
  variant?: "inline" | "card";
  title?: string;
  /** Pre-loaded field map from list enrichment (AdminPanel / EngineerReview). */
  prefetchedFields?: Record<string, string>;
};

function FieldValue({
  fieldType,
  value,
  yesLabel,
  noLabel,
}: {
  fieldType: string;
  value: string;
  yesLabel: string;
  noLabel: string;
}) {
  if (fieldType === "checkbox") {
    return (
      <Badge variant={value === "true" ? "default" : "outline"}>
        {value === "true" ? yesLabel : noLabel}
      </Badge>
    );
  }
  return <span className="font-medium">{value || "—"}</span>;
}

export function ExpenseFormFieldsDisplay({
  expenseId,
  organizationId,
  context = "review",
  className,
  variant = "inline",
  title,
  prefetchedFields,
}: ExpenseFormFieldsDisplayProps) {
  const { t } = useTranslation(["expenses", "common", "admin"]);
  const [nodes, setNodes] = useState<ExpenseFormFieldDisplayNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const prefetchKey = prefetchedFields ? JSON.stringify(prefetchedFields) : "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNodes([]);

    void fetchExpenseFormFieldDisplayGrouped(supabase, expenseId, organizationId, context === "review" ? "review" : "detail", {
      prefetchedFields,
    })
      .then((result) => {
        if (!cancelled) {
          if (result.ok) {
            setNodes(result.nodes);
          } else {
            setError(t("fieldDisplay.loadFailed", { ns: "expenses" }));
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError(t("fieldDisplay.loadFailed", { ns: "expenses" }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  // retryCount triggers re-fetch when user clicks Retry
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenseId, organizationId, context, prefetchKey, retryCount]);

  const handleRetry = useCallback(() => {
    setRetryCount((n) => n + 1);
  }, []);

  const heading =
    title ??
    (context === "detail"
      ? t("fieldDisplay.sectionTitle", { ns: "expenses", defaultValue: "Additional Information" })
      : t("admin:review.additionalInformation", { defaultValue: "Additional Information" }));

  if (loading) {
    return (
      <AsyncOperationProgress
        status="running"
        title={t("fieldDisplay.loading", { ns: "expenses" })}
        description={t("fieldDisplay.loadingDescription", { ns: "expenses" })}
        compact
        className={className}
      />
    );
  }

  if (error) {
    return (
      <AsyncOperationProgress
        status="error"
        title={t("fieldDisplay.loadFailed", { ns: "expenses" })}
        description={t("fieldDisplay.loadFailedDescription", { ns: "expenses" })}
        retryLabel={t("fieldDisplay.retry", { ns: "expenses" })}
        onRetry={handleRetry}
        className={className}
      />
    );
  }

  if (nodes.length === 0) return null;

  const yesLabel = t("fieldDisplay.checkboxYes", { ns: "expenses", defaultValue: "Yes" });
  const noLabel = t("fieldDisplay.checkboxNo", { ns: "expenses", defaultValue: "No" });

  const textSm = variant === "card" ? "text-sm" : "text-xs";
  const textBase = variant === "card" ? "text-base" : "text-sm";

  const fieldRow = (
    <dl className="flex flex-col gap-y-1.5">
      {nodes.map((node) => {
        if (node.kind === "field") {
          const field = node.field;
          return (
            <div
              key={field.stableId}
              className="flex items-baseline gap-1.5"
            >
              <dt className={cn("font-medium text-muted-foreground shrink-0", textSm)}>
                {field.label}:
              </dt>
              <dd className={cn("min-w-0 break-words", textBase)}>
                <FieldValue fieldType={field.fieldType} value={field.value} yesLabel={yesLabel} noLabel={noLabel} />
              </dd>
            </div>
          );
        }

        // Group node: parent field + indented sub-fields
        const { group } = node;
        return (
          <div key={group.groupStableId} className="flex flex-col gap-y-1">
            {/* Parent template field */}
            <div className="flex items-baseline gap-1.5">
              <dt className={cn("font-medium text-muted-foreground shrink-0", textSm)}>
                {group.groupLabel}:
              </dt>
              <dd className={cn("min-w-0 break-words", textBase)}>
                <span className="font-medium">{group.groupValue || "—"}</span>
              </dd>
            </div>
            {/* Sub-fields indented */}
            {group.children.map((child) => (
              <div
                key={child.stableId}
                className="flex items-baseline gap-1.5 pl-4"
              >
                <dt className={cn("font-medium text-muted-foreground shrink-0", textSm)}>
                  {child.label}:
                </dt>
                <dd className={cn("min-w-0 break-words", textBase)}>
                  <FieldValue fieldType={child.fieldType} value={child.value} yesLabel={yesLabel} noLabel={noLabel} />
                </dd>
              </div>
            ))}
          </div>
        );
      })}
    </dl>
  );

  if (variant === "card") {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>{heading}</CardTitle>
          <CardDescription>{t("admin:review.formFieldsDescription", { defaultValue: "Category-specific form field data" })}</CardDescription>
        </CardHeader>
        <CardContent>{fieldRow}</CardContent>
      </Card>
    );
  }

  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-sm font-medium mb-2">{heading}</p>
      {fieldRow}
    </div>
  );
}
