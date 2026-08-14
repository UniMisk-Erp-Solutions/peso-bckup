/**
 * Filters (DOC-080 Phase 15).
 *
 * Every predicate is sent to the server. The browser never queries
 * expense_form_field_values to work out which rows match a custom field — the
 * options come from the filter-options RPC and the matching happens in SQL.
 *
 * Custom-field semantics: AND across fields, OR within one field's values.
 */

import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEBUG_REVIEW_SORTS } from "./schemas";
import { DEBUG_PAGE_SIZES, type DebugReviewFilterState } from "./hooks/useDebugReviewFilters";
import type {
  DebugCustomFilter,
  DebugReviewFilterOptions,
  DebugReviewSort,
  DebugTimePeriod,
} from "./types";

const TIME_PERIODS: DebugTimePeriod[] = ["all", "week", "month", "year"];
const ALL = "__all__";

/** Stable id so a renamed field does not silently change what is filtered. */
function fieldKey(source: string, id: string) {
  return `${source}:${id}`;
}

export function DebugReviewFilters({
  filters,
  options,
  activeFilterCount,
  onStatuses,
  onCategories,
  onTimePeriod,
  onActionableOnly,
  onCustomFilters,
  onSort,
  onPageSize,
  onReset,
}: {
  filters: DebugReviewFilterState;
  options: DebugReviewFilterOptions | null;
  activeFilterCount: number;
  onStatuses: (v: string[]) => void;
  onCategories: (v: string[]) => void;
  onTimePeriod: (v: DebugTimePeriod) => void;
  onActionableOnly: (v: boolean) => void;
  onCustomFilters: (v: DebugCustomFilter[]) => void;
  onSort: (v: DebugReviewSort) => void;
  onPageSize: (v: number) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation(["debugReview", "expenses"]);

  const setCustomValue = (source: string, fieldId: string, value: string) => {
    const rest = filters.customFilters.filter(
      (f) => fieldKey(f.source, f.field_id) !== fieldKey(source, fieldId),
    );
    if (value === ALL) {
      onCustomFilters(rest);
      return;
    }
    onCustomFilters([
      ...rest,
      { source: source as "template" | "branch", field_id: fieldId, values: [value] },
    ]);
  };

  const customValue = (source: string, fieldId: string) =>
    filters.customFilters.find((f) => fieldKey(f.source, f.field_id) === fieldKey(source, fieldId))
      ?.values[0] ?? ALL;

  const optionValues = (raw: unknown): string[] => {
    if (Array.isArray(raw)) {
      return raw
        .map((o) => (typeof o === "string" ? o : (o as { value?: string })?.value))
        .filter((v): v is string => typeof v === "string" && v.length > 0);
    }
    return [];
  };

  return (
    <Card data-testid="debug-filters">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <p className="font-medium">{t("debugReview:filters.title")}</p>
          <div className="flex items-center gap-2">
            {activeFilterCount > 0 && (
              <Badge variant="secondary">
                {t("debugReview:filters.activeCount", { count: activeFilterCount })}
              </Badge>
            )}
            <Button size="sm" variant="ghost" onClick={onReset} data-testid="debug-filters-reset">
              {t("debugReview:filters.reset")}
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label>{t("debugReview:filters.status")}</Label>
            <Select
              value={filters.statuses[0] ?? ALL}
              onValueChange={(v) => onStatuses(v === ALL ? [] : [v])}
            >
              <SelectTrigger data-testid="debug-filter-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("debugReview:filters.allStatuses")}</SelectItem>
                {(options?.statuses ?? []).map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`expenses:status.${s}`, { defaultValue: s })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("debugReview:filters.category")}</Label>
            <Select
              value={filters.categories[0] ?? ALL}
              onValueChange={(v) => onCategories(v === ALL ? [] : [v])}
            >
              <SelectTrigger data-testid="debug-filter-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("debugReview:filters.allCategories")}</SelectItem>
                {(options?.categories ?? []).map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("debugReview:filters.sort")}</Label>
            <Select value={filters.sort} onValueChange={(v) => onSort(v as DebugReviewSort)}>
              <SelectTrigger data-testid="debug-filter-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEBUG_REVIEW_SORTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`debugReview:filters.sorts.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("debugReview:filters.timePeriod")}</Label>
            <Select
              value={filters.timePeriod}
              onValueChange={(v) => onTimePeriod(v as DebugTimePeriod)}
            >
              <SelectTrigger data-testid="debug-filter-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`debugReview:filters.periods.${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {(options?.custom_fields.length ?? 0) > 0 && (
          <div className="space-y-2">
            <Label>{t("debugReview:filters.customFields")}</Label>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {options!.custom_fields.map((f) => {
                const values = optionValues(f.options);
                if (values.length === 0) return null;
                return (
                  <div key={fieldKey(f.source, f.field_id)} className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      {f.label ?? f.field_key}
                    </Label>
                    <Select
                      value={customValue(f.source, f.field_id)}
                      onValueChange={(v) => setCustomValue(f.source, f.field_id, v)}
                    >
                      <SelectTrigger
                        data-testid={`debug-filter-custom-${fieldKey(f.source, f.field_id)}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL}>{t("debugReview:filters.allStatuses")}</SelectItem>
                        {values.map((v) => (
                          <SelectItem key={v} value={v}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <Switch
              id="debug-actionable-only"
              checked={filters.actionableOnly}
              onCheckedChange={onActionableOnly}
              data-testid="debug-filter-actionable"
            />
            <Label htmlFor="debug-actionable-only">
              {t("debugReview:filters.actionableOnly")}
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="debug-page-size">{t("debugReview:filters.pageSize")}</Label>
            <Select value={String(filters.pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
              <SelectTrigger id="debug-page-size" className="w-24" data-testid="debug-page-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEBUG_PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
