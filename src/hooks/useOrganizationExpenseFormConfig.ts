import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_BASE_FIELD_CONFIG,
  resolveBaseFieldConfig,
  type BaseExpenseFieldKey,
  type BaseFieldConfig,
} from "@/lib/expenseFormConfig";
import { useTranslation } from "react-i18next";

const DEFAULT_EN_LABELS: Record<BaseExpenseFieldKey, string> = {
  category: "Category",
  title: "Title",
  destination: "Vendor / Location",
  expense_date: "Expense Date",
  purpose: "Purpose",
  amount: "Amount",
};

// expenses.json uses camelCase keys for base fields; map snake_case field keys
const FIELD_I18N_KEY: Record<BaseExpenseFieldKey, string> = {
  category: "form.fields.category",
  title: "form.fields.title",
  destination: "form.fields.destination",
  expense_date: "form.fields.expenseDate",
  purpose: "form.fields.purpose",
  amount: "form.fields.amount",
};

/**
 * Resolves org-custom base-field config from `organization_expense_form_fields`.
 *
 * Labels: if the org has not customized the label (i.e. the stored label equals
 * the hardcoded English default), the i18n translation for the active locale is
 * used instead. This means org-custom labels always win, but the default labels
 * follow the user's language.
 *
 * Result is stable across re-renders when `organizationId` is unchanged.
 */
export function useOrganizationExpenseFormConfig(
  organizationId: string | null | undefined,
) {
  const { t } = useTranslation("expenses");

  const {
    data: rawRows,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["org-expense-form-config", organizationId],
    enabled: Boolean(organizationId),
    staleTime: 5 * 60 * 1000, // 5 minutes — field config changes infrequently
    gcTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error: dbError } = await supabase
        .from("organization_expense_form_fields")
        .select(
          "field_key, label, is_visible, is_required, display_order, show_on_submit, show_on_review, show_on_detail, input_type, options",
        )
        .eq("organization_id", organizationId!);

      if (dbError) throw dbError;
      return data ?? [];
    },
  });

  const config = resolveBaseFieldConfig(rawRows ?? null);

  // Translate labels: only replace with i18n label when the org hasn't
  // customized the label (i.e. it still equals the hardcoded EN default).
  const translatedConfig = Object.fromEntries(
    (Object.keys(config) as BaseExpenseFieldKey[]).map((key) => {
      const field = config[key];
      const enDefault = DEFAULT_EN_LABELS[key];
      const i18nLabel = t(FIELD_I18N_KEY[key], { defaultValue: "" });

      const label =
        field.label !== enDefault || !i18nLabel ? field.label : i18nLabel;

      return [key, { ...field, label }];
    }),
  ) as Record<BaseExpenseFieldKey, BaseFieldConfig>;

  return {
    config: translatedConfig,
    rawConfig: config,
    isLoading,
    isError,
    error,
    /** True when the org has no rows yet — using all defaults. */
    isDefault: !rawRows || rawRows.length === 0,
    /**
     * Returns the resolved label for a field in the current locale.
     * Falls back to the DEFAULT_BASE_FIELD_CONFIG label when the key is unknown.
     */
    getFieldLabel(key: BaseExpenseFieldKey): string {
      return translatedConfig[key]?.label ?? DEFAULT_BASE_FIELD_CONFIG[key]?.label ?? key;
    },
    /**
     * Returns true when the field should be shown in review panels.
     * Defaults to true when config hasn't loaded yet (fail-open).
     */
    isVisibleOnReview(key: BaseExpenseFieldKey): boolean {
      if (isLoading || !rawRows) return true;
      return translatedConfig[key]?.show_on_review ?? true;
    },
    /**
     * Returns true when the field should be shown in detail / read-only views.
     * Defaults to true when config hasn't loaded yet (fail-open).
     */
    isVisibleOnDetail(key: BaseExpenseFieldKey): boolean {
      if (isLoading || !rawRows) return true;
      return translatedConfig[key]?.show_on_detail ?? true;
    },
  };
}

export type OrganizationExpenseFormConfig = ReturnType<typeof useOrganizationExpenseFormConfig>;
