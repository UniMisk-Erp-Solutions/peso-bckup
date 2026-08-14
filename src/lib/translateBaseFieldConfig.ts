import type { TFunction } from "i18next";
import type { BaseExpenseFieldKey, BaseFieldConfig } from "@/lib/expenseFormConfig";
import { DEFAULT_BASE_FIELD_CONFIG } from "@/lib/expenseFormConfig";

const FIELD_LABEL_KEYS: Record<BaseExpenseFieldKey, string> = {
  category: "form.fields.category",
  title: "form.fields.title",
  destination: "form.fields.destination",
  expense_date: "form.fields.expenseDate",
  purpose: "form.fields.purpose",
  amount: "form.fields.amount",
};

/**
 * Applies i18n labels to org base field config, but only when the admin has NOT set a custom
 * label. A custom label is one that differs from the English default in DEFAULT_BASE_FIELD_CONFIG.
 * If the DB label matches the default (or is absent), replace with the locale translation.
 */
export function translateBaseFieldConfig(
  config: Record<BaseExpenseFieldKey, BaseFieldConfig>,
  t: TFunction,
): Record<BaseExpenseFieldKey, BaseFieldConfig> {
  const out = { ...config };
  for (const key of Object.keys(FIELD_LABEL_KEYS) as BaseExpenseFieldKey[]) {
    if (!out[key]) continue;
    const configLabel = out[key].label;
    const defaultLabel = DEFAULT_BASE_FIELD_CONFIG[key]?.label ?? "";
    // Preserve custom admin labels; only apply i18n when label is the English default or absent
    if (!configLabel || configLabel === defaultLabel) {
      out[key] = {
        ...out[key],
        label: t(FIELD_LABEL_KEYS[key]),
      };
    }
  }
  return out;
}

export function baseFieldLabel(t: TFunction, key: BaseExpenseFieldKey): string {
  return t(FIELD_LABEL_KEYS[key]);
}
