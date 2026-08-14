/**
 * Custom-field filters (DOC-080 §4).
 *
 * Renders only the fields whose parent value currently reveals them, so the row
 * grows one control at a time instead of showing every branch definition at
 * once. Options come from the filter-options RPC — the browser never queries
 * expense_form_field_values to discover them — and every filter is keyed by the
 * STABLE template/branch UUID, so renaming a field cannot silently change what
 * is being filtered.
 *
 * Because hidden fields are pruned from state, they cannot leak into
 * p_custom_filters and narrow the results invisibly.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseFieldOptions } from "@/lib/expenseCustomFieldFilters";
import {
  applySelection,
  customFiltersToValues,
  fieldKeyOf,
  pruneHidden,
  valuesToCustomFilters,
  visibleFields,
} from "./customFieldGraph";
import type {
  ReviewCustomFilter,
  ReviewQueueFilterOptions,
} from "@/features/reviewQueueServer/types";

const ALL = "__all__";

export function ReviewCustomFieldFilters({
  options,
  customFilters,
  onChange,
  className,
}: {
  options: ReviewQueueFilterOptions | null;
  customFilters: ReviewCustomFilter[];
  onChange: (next: ReviewCustomFilter[]) => void;
  className?: string;
}) {
  const { t } = useTranslation("admin");
  const fields = useMemo(() => options?.custom_fields ?? [], [options]);
  const values = useMemo(() => customFiltersToValues(customFilters), [customFilters]);

  // Only the fields the current selections actually reveal.
  const shown = useMemo(
    () => visibleFields(fields, values).filter((f) => parseFieldOptions(f.options).length > 0),
    [fields, values],
  );

  if (shown.length === 0) return null;

  const select = (key: string, raw: string) => {
    const value = raw === ALL ? "" : raw;
    onChange(valuesToCustomFilters(pruneHidden(fields, applySelection(fields, values, key, value))));
  };

  return (
    <div className={className} data-testid="review-custom-fields">
      <p className="text-sm font-medium mb-2">{t("review.formFieldsTitle")}</p>
      {/* Only active controls occupy cells, so removing a child closes the gap
          rather than leaving an empty slot behind. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {shown.map((f) => {
          const key = fieldKeyOf(f);
          const choices = parseFieldOptions(f.options);
          return (
            <div key={key} className="space-y-1.5" data-testid={`review-custom-field-${key}`}>
              <Label className="text-xs text-muted-foreground">{f.label ?? f.field_key}</Label>
              <Select value={values[key] ?? ALL} onValueChange={(v) => select(key, v)}>
                <SelectTrigger data-testid={`review-custom-trigger-${key}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("review.allValues")}</SelectItem>
                  {choices.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
