/**
 * ExpenseBaseFieldsDisplay
 *
 * Renders the 6 org-configurable base fields (category, title, destination,
 * expense_date, purpose, amount) from a plain data object in a read-only format.
 *
 * Uses `useOrganizationExpenseFormConfig` so org-custom labels and visibility
 * flags are respected on every surface (AdminPanel, EngineerReview, ExpenseDetail,
 * mobile views, batch panels, accountant view).
 *
 * Pass `context` to apply `show_on_review` / `show_on_detail` filtering.
 */

import { useOrganizationExpenseFormConfig } from "@/hooks/useOrganizationExpenseFormConfig";
import { type BaseExpenseFieldKey, BASE_EXPENSE_FIELD_KEYS } from "@/lib/expenseFieldDisplayModel";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type BaseFieldValues = Partial<Record<BaseExpenseFieldKey, string | null>>;

export type BaseFieldDisplayContext = "review" | "detail" | "all";

export type ExpenseBaseFieldsDisplayProps = {
  organizationId: string;
  values: BaseFieldValues;
  context?: BaseFieldDisplayContext;
  /** "inline" = label/value pairs; "card" = wrapped in a Card. Default: "inline". */
  variant?: "inline" | "card";
  title?: string;
  className?: string;
  /** When true, shows a skeleton row while org config is loading. Default: false (renders with defaults). */
  showLoadingState?: boolean;
};

function BaseFieldRow({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant: "inline" | "card";
}) {
  return (
    <div className="space-y-1 min-w-0">
      <div
        className={cn(
          "text-muted-foreground",
          variant === "card" ? "text-sm font-medium" : "text-xs",
        )}
      >
        {label}
      </div>
      <div className={variant === "card" ? "text-base" : "text-sm"}>
        <span className="font-medium">{value || "—"}</span>
      </div>
    </div>
  );
}

export function ExpenseBaseFieldsDisplay({
  organizationId,
  values,
  context = "all",
  variant = "inline",
  title,
  className,
  showLoadingState = false,
}: ExpenseBaseFieldsDisplayProps) {
  const { t } = useTranslation(["expenses"]);
  const { config, isLoading, getFieldLabel, isVisibleOnReview, isVisibleOnDetail } =
    useOrganizationExpenseFormConfig(organizationId);

  if (showLoadingState && isLoading) {
    return (
      <div className={cn("flex items-center gap-2 text-sm text-muted-foreground py-2", className)}>
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loadingFields", { defaultValue: "Loading…" })}
      </div>
    );
  }

  // Filter fields by visibility: org config + context
  const visibleFields = BASE_EXPENSE_FIELD_KEYS.filter((key) => {
    const fieldConfig = config[key];
    if (!fieldConfig?.is_visible) return false;

    if (context === "review" && !isVisibleOnReview(key)) return false;
    if (context === "detail" && !isVisibleOnDetail(key)) return false;

    const val = values[key];
    return val !== null && val !== undefined && String(val).trim() !== "";
  });

  if (visibleFields.length === 0) return null;

  const heading = title ?? t("baseFields.sectionTitle", { defaultValue: "Expense Details" });

  const fieldList = (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
      {visibleFields
        .sort((a, b) => (config[a]?.display_order ?? 99) - (config[b]?.display_order ?? 99))
        .map((key) => (
          <BaseFieldRow
            key={key}
            label={getFieldLabel(key)}
            value={String(values[key] ?? "")}
            variant={variant}
          />
        ))}
    </div>
  );

  if (variant === "card") {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>{heading}</CardTitle>
        </CardHeader>
        <CardContent>{fieldList}</CardContent>
      </Card>
    );
  }

  return (
    <div className={className}>
      {title && <p className="text-sm font-medium mb-2">{heading}</p>}
      {fieldList}
    </div>
  );
}
