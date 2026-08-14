import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { blurFocusedNumberInputOnWheel } from "@/lib/numberInputWheel";
import { SearchableSelectField } from "@/components/SearchableSelectField";
import { useRecommendedFieldOptions, fieldRecKey } from "@/hooks/useRecommendedFieldOptions";
import type { SelectFieldRef } from "@/lib/recommendedFormFieldOptions";
import type { BaseFieldConfig } from "@/lib/expenseFormConfig";

type BaseExpenseFieldInputProps = {
  config: BaseFieldConfig;
  value: string;
  onChange: (value: string) => void;
  /** Org-level master feature flag. When false the default control is always used. */
  featureEnabled: boolean;
  organizationId?: string | null;
  userId?: string | null;
  id?: string;
  placeholder?: string;
  /** Existing built-in control, rendered for input_type "default" or when feature off. */
  defaultControl: ReactNode;
};

/**
 * Renders a base expense field using its configured input_type override.
 * Falls back to the built-in control (defaultControl) when the feature is off
 * or input_type is "default".
 */
export function BaseExpenseFieldInput({
  config,
  value,
  onChange,
  featureEnabled,
  organizationId,
  userId,
  id,
  placeholder,
  defaultControl,
}: BaseExpenseFieldInputProps) {
  const isDropdown = featureEnabled && config.input_type === "dropdown";
  const fields: SelectFieldRef[] = isDropdown
    ? [{ fieldKey: config.field_key, fieldKind: "base", options: config.options }]
    : [];
  const recommendedByKey = useRecommendedFieldOptions(organizationId, userId, fields);

  if (!featureEnabled || config.input_type === "default") {
    return <>{defaultControl}</>;
  }

  if (config.input_type === "dropdown") {
    return (
      <SearchableSelectField
        id={id}
        value={value}
        onValueChange={onChange}
        options={config.options}
        recentOptions={recommendedByKey[fieldRecKey("base", config.field_key)] ?? []}
        placeholder={placeholder}
      />
    );
  }

  if (config.input_type === "number") {
    return (
      <Input
        id={id}
        type="number"
        step="0.01"
        inputMode="decimal"
        onWheelCapture={blurFocusedNumberInputOnWheel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    );
  }

  // input_type === "text"
  return (
    <Input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}
