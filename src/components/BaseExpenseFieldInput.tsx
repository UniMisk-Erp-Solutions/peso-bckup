import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { blurFocusedNumberInputOnWheel } from "@/lib/numberInputWheel";
import { SearchableSelectField } from "@/components/SearchableSelectField";
import { RecentValueTextInput } from "@/components/RecentValueTextInput";
import { useRecommendedFieldOptions, fieldRecKey } from "@/hooks/useRecommendedFieldOptions";
import type { SelectFieldRef } from "@/lib/recommendedFormFieldOptions";
import type { BaseFieldConfig } from "@/lib/expenseFormConfig";
import { isEligibleBaseFieldForMemory } from "@/lib/expenseFieldMemory";

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
  /**
   * DOC-130: whether the org has expense_field_memory turned on at all --
   * independent of `featureEnabled` above, which gates a DIFFERENT flag
   * (base-field-input-customization, i.e. dropdown/number overrides). This
   * decides the RENDER PATH deterministically (memory-eligible fields always
   * go through RecentValueTextInput when the org has the feature on), so
   * "feature on, zero suggestions yet" and "feature off" can never be
   * confused with each other from the outside -- both look identical
   * (RecentValueTextInput with an empty list renders exactly like a plain
   * input), but the code path taken to get there is no longer a guess based
   * on whether data happened to arrive in time.
   */
  memoryEnabled?: boolean;
  /**
   * DOC-130: recently-used free-text values for this base field (title /
   * destination / purpose only), already fetched by the parent form and
   * capped at 25. Undefined/empty renders a plain input identical to today's
   * behavior -- this prop is purely additive.
   */
  recentValues?: string[];
  /**
   * Disables the rendered control (dropdown/number/text branches below).
   * Used e.g. to fail-closed a manually-typed expense date while date-lock
   * data is unproven (loading/error) -- the Calendar's own `disabled`
   * predicate only covers the "default" picker control, not an admin who
   * has configured this field as free-text/number/dropdown input_type.
   * `defaultControl` is rendered as given by the caller and must disable
   * itself; this prop does not reach it.
   */
  disabled?: boolean;
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
  memoryEnabled = false,
  recentValues,
  disabled = false,
}: BaseExpenseFieldInputProps) {
  const isDropdown = featureEnabled && config.input_type === "dropdown";
  const fields: SelectFieldRef[] = isDropdown
    ? [{ fieldKey: config.field_key, fieldKind: "base", options: config.options }]
    : [];
  const recommendedByKey = useRecommendedFieldOptions(organizationId, userId, fields);

  // DOC-130: free-text memory is independent of the base-field-input-customization
  // flag above -- it applies to "default"/"text" rendering, not the dropdown/number
  // overrides that flag controls. The render path is decided by memoryEnabled +
  // field eligibility ALONE -- never by whether recentValues happens to have
  // arrived yet, so "feature on, no history yet" and "feature off" cannot be
  // confused with each other from the outside. RecentValueTextInput with an
  // empty/undefined list renders identically to a plain input, so this is
  // purely a code-path change, not a visual one.
  if (memoryEnabled && isEligibleBaseFieldForMemory(config.field_key, config.input_type)) {
    return (
      <RecentValueTextInput
        id={id}
        value={value}
        onChange={onChange}
        recentValues={recentValues ?? []}
        placeholder={placeholder}
        multiline={config.field_key === "purpose"}
        rows={3}
      />
    );
  }

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
        disabled={disabled}
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
        disabled={disabled}
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
      disabled={disabled}
    />
  );
}
