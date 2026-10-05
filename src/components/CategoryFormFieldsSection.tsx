import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BranchFieldInputs } from "@/components/BranchFieldInputs";
import { SearchableSelectField } from "@/components/SearchableSelectField";
import {
  buildInitialBranchValues,
  getVisibleBranches,
  isBranchUnderTemplate,
} from "@/lib/conditionalFormFields";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useRecommendedFieldOptions, fieldRecKey } from "@/hooks/useRecommendedFieldOptions";
import type { FormFieldKind } from "@/lib/recommendedFormFieldOptions";
import { RecentValueTextInput } from "@/components/RecentValueTextInput";
import { useRecentExpenseFieldValues } from "@/hooks/useRecentExpenseFieldValues";
import { isEligibleCustomFieldType, memoryFieldKey } from "@/lib/expenseFieldMemory";

type CategoryFormFieldsSectionProps = {
  categoryFormFields: Array<{
    template: {
      id: string;
      name: string;
      field_type: string;
      required: boolean;
      placeholder?: string | null;
      help_text?: string | null;
      validation_rules?: { min?: number; max?: number };
      options?: string[] | null;
    };
    required?: boolean | null;
  }>;
  formFieldValues: Record<string, string>;
  onFormFieldValuesChange: (values: Record<string, string>) => void;
  optionBranches: OptionBranchDefinition[];
  branchValues: Record<string, string>;
  onBranchValuesChange: (values: Record<string, string>) => void;
  allowNested: boolean;
  organizationId?: string | null;
  userId?: string | null;
  /** DOC-097 hotfix pt.3: when set, fired whenever a select-type template's
   *  value changes so the caller can fetch that ONE option's branches
   *  on-demand (useOnDemandOptionBranches) instead of the whole template
   *  ever having downloaded all of them up front. Optional so this
   *  component still works standalone/in tests without it. */
  onSelectOptionValue?: (templateId: string, optionValue: string) => void;
  /** DOC-100 pt.2: scopes every generated `id`/`htmlFor` to this instance.
   *  Required whenever more than one CategoryFormFieldsSection for the SAME
   *  template can be mounted at once (e.g. one per batch line) — without it,
   *  every instance renders the identical `field-${template.id}` DOM id,
   *  breaking label/input association. Single-instance callers (the single
   *  expense form, one shared-field renderer per template) can omit it. */
  instanceId?: string;
  /**
   * INCIDENT hotfix (2026-09) — precise (templateId, value) resolution
   * status from useOnDemandOptionBranches. When provided:
   *   - branch-value reconciliation (see the effect below) only runs once
   *     EVERY currently-selected select template's config is `ready` for its
   *     current value, so a config that's still loading (or errored) can
   *     never be mistaken for "nothing required" and wipe an existing answer;
   *   - a loading/error hint renders under a select field whose own value's
   *     config isn't resolved yet, instead of the field silently doing
   *     nothing.
   * Optional so this component still works standalone/in tests without it —
   * omitting it restores the previous best-effort (unsafe) behavior.
   */
  isOptionResolved?: (templateId: string, optionValue: string) => boolean;
  isOptionLoading?: (templateId: string, optionValue: string) => boolean;
  isOptionErrored?: (templateId: string, optionValue: string) => boolean;
  /** DOC-130: org feature flag for free-text recent-value suggestions on
   *  custom/branch text+textarea fields. Defaults to false (no visible change). */
  memoryEnabled?: boolean;
};

export function CategoryFormFieldsSection({
  categoryFormFields,
  formFieldValues,
  onFormFieldValuesChange,
  optionBranches,
  branchValues,
  onBranchValuesChange,
  allowNested,
  organizationId,
  userId,
  onSelectOptionValue,
  instanceId,
  isOptionResolved,
  isOptionLoading,
  isOptionErrored,
  memoryEnabled = false,
}: CategoryFormFieldsSectionProps) {
  const { t } = useTranslation("expenses");
  const idScope = instanceId ? `${instanceId}-` : "";

  const memoryIdentities = useMemo(() => {
    const ids: string[] = [];
    for (const field of categoryFormFields) {
      if (isEligibleCustomFieldType(field.template.field_type)) {
        ids.push(memoryFieldKey("custom", field.template.id));
      }
    }
    for (const branch of optionBranches) {
      if (isEligibleCustomFieldType(branch.field_type)) {
        ids.push(memoryFieldKey("branch", branch.id));
      }
    }
    return ids;
  }, [categoryFormFields, optionBranches]);

  const recentTextByKey = useRecentExpenseFieldValues(
    organizationId,
    userId,
    memoryIdentities,
    memoryEnabled,
  );

  const selectFieldRefs = useMemo(() => {
    const refs: Array<{ fieldKey: string; fieldKind: FormFieldKind; options: string[] }> = [];
    for (const field of categoryFormFields) {
      const tpl = field.template;
      if (tpl.field_type === "select" && tpl.options?.length) {
        refs.push({
          fieldKey: tpl.id,
          fieldKind: "template",
          options: tpl.options,
        });
      }
    }
    for (const branch of optionBranches) {
      if (branch.field_type === "select" && branch.options?.length) {
        refs.push({
          fieldKey: branch.id,
          fieldKind: "branch",
          options: branch.options,
        });
      }
    }
    return refs;
  }, [categoryFormFields, optionBranches]);

  const recommendedByKey = useRecommendedFieldOptions(organizationId, userId, selectFieldRefs);

  // Reconcile branchValues once every currently-selected select template's
  // branch config is fully resolved for its CURRENT value — never inferred
  // from an empty/stale optionBranches array. If even one relevant selection
  // is still loading or errored, this is a deliberate no-op: an in-flight or
  // failed fetch must never be treated as "this template has no conditional
  // fields", which would otherwise silently wipe a still-valid existing
  // answer for a DIFFERENT template whose fetch just hasn't resolved yet.
  // Declared before the categoryFormFields.length === 0 early return below so
  // hook call order stays stable across renders (Rules of Hooks).
  useEffect(() => {
    if (categoryFormFields.length === 0) return;
    const selectedTemplates = categoryFormFields
      .filter((f) => f.template.field_type === "select")
      .map((f) => ({ id: f.template.id, value: formFieldValues[f.template.id] }))
      .filter((s): s is { id: string; value: string } => !!s.value);

    if (selectedTemplates.length === 0) return;
    if (isOptionResolved && !selectedTemplates.every((s) => isOptionResolved(s.id, s.value))) {
      return;
    }

    const next = buildInitialBranchValues(optionBranches, formFieldValues, allowNested, branchValues);
    const nextKeys = Object.keys(next);
    const currentKeys = Object.keys(branchValues);
    const changed =
      nextKeys.length !== currentKeys.length || nextKeys.some((k) => branchValues[k] !== next[k]);
    if (changed) {
      onBranchValuesChange(next);
    }
    // Re-run only when the resolved config or the relevant selections change —
    // not on every branchValues edit (which would fight the user's typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryFormFields, optionBranches, formFieldValues, allowNested, isOptionResolved]);

  if (categoryFormFields.length === 0) return null;

  const handleTemplateSelectChange = (templateId: string, val: string) => {
    const nextTemplate = { ...formFieldValues, [templateId]: val };
    onFormFieldValuesChange(nextTemplate);
    // INCIDENT hotfix (2026-09): this option's own branch DEFINITIONS are not
    // known synchronously — they're fetched on demand by onSelectOptionValue
    // and can only be trusted once resolved. Recomputing branch values here
    // against whatever `optionBranches` happens to hold right now (which may
    // still belong to a DIFFERENT, previously-selected value, or simply be
    // empty because the fetch hasn't started) is exactly the bug that let a
    // pending/stale fetch look identical to "nothing required" and silently
    // drop already-entered values. Reconciliation happens ONLY in the effect
    // above, and only once the config for THIS value is actually `ready`.
    onSelectOptionValue?.(templateId, val);
  };

  const handleBranchChange = (branchId: string, val: string) => {
    const next = { ...branchValues, [branchId]: val };
    const branch = optionBranches.find((b) => b.id === branchId);
    if (branch?.field_type === "select") {
      onBranchValuesChange(
        buildInitialBranchValues(optionBranches, formFieldValues, allowNested, next),
      );
    } else {
      onBranchValuesChange(next);
    }
  };

  const visibleBranches = getVisibleBranches(
    optionBranches,
    formFieldValues,
    branchValues,
    allowNested,
  );

  return (
    <div className="space-y-4 p-4 bg-muted/50 rounded-lg border">
      <h3 className="font-semibold text-sm">{t("form.customFields.sectionTitle")}</h3>
      {categoryFormFields.map((field) => {
        const template = field.template;
        const fieldId = `field-${idScope}${template.id}`;
        const isRequired = field.required !== null ? field.required : template.required;
        const value = formFieldValues[template.id] || "";

        return (
          <div key={template.id} className="space-y-2">
            <Label htmlFor={fieldId}>
              {template.name}
              {isRequired && <span className="text-red-500 ml-1">*</span>}
            </Label>

            {template.field_type === "text" && (
              <RecentValueTextInput
                id={fieldId}
                value={value}
                onChange={(v) =>
                  onFormFieldValuesChange({
                    ...formFieldValues,
                    [template.id]: v,
                  })
                }
                recentValues={recentTextByKey[memoryFieldKey("custom", template.id)] ?? []}
                placeholder={template.placeholder || ""}
                required={isRequired}
              />
            )}

            {template.field_type === "number" && (
              <Input
                id={fieldId}
                type="number"
                value={value}
                onChange={(e) =>
                  onFormFieldValuesChange({
                    ...formFieldValues,
                    [template.id]: e.target.value,
                  })
                }
                placeholder={template.placeholder || ""}
                min={template.validation_rules?.min}
                max={template.validation_rules?.max}
                required={isRequired}
              />
            )}

            {template.field_type === "date" && (
              <Input
                id={fieldId}
                type="date"
                value={value}
                onChange={(e) =>
                  onFormFieldValuesChange({
                    ...formFieldValues,
                    [template.id]: e.target.value,
                  })
                }
                required={isRequired}
              />
            )}

            {template.field_type === "textarea" && (
              <RecentValueTextInput
                id={fieldId}
                value={value}
                onChange={(v) =>
                  onFormFieldValuesChange({
                    ...formFieldValues,
                    [template.id]: v,
                  })
                }
                recentValues={recentTextByKey[memoryFieldKey("custom", template.id)] ?? []}
                placeholder={template.placeholder || ""}
                required={isRequired}
                multiline
                rows={3}
              />
            )}

            {template.field_type === "select" && (
              <>
                <SearchableSelectField
                  id={fieldId}
                  value={value}
                  onValueChange={(val) => handleTemplateSelectChange(template.id, val)}
                  options={template.options || []}
                  recentOptions={recommendedByKey[fieldRecKey("template", template.id)] ?? []}
                  placeholder={template.placeholder || t("form.customFields.selectOption")}
                />
                {value && isOptionLoading?.(template.id, value) && (
                  <p className="text-xs text-muted-foreground" role="status">
                    {t("form.customFields.loadingAdditionalFields", "Loading project information…")}
                  </p>
                )}
                {value && isOptionErrored?.(template.id, value) && (
                  <p className="text-xs text-destructive" role="alert">
                    {t(
                      "form.customFields.loadAdditionalFieldsError",
                      "Could not load additional field configuration for this selection. Please retry before submitting.",
                    )}
                  </p>
                )}
                {optionBranches.some((b) => b.parent_template_id === template.id) && (
                  <BranchFieldInputs
                    visibleBranches={visibleBranches.filter((v) =>
                      isBranchUnderTemplate(v.branch, template.id, optionBranches),
                    )}
                    branchValues={branchValues}
                    onBranchChange={handleBranchChange}
                    idPrefix={`tpl-${idScope}${template.id}`}
                    recommendedByKey={recommendedByKey}
                    recentTextByKey={recentTextByKey}
                  />
                )}
              </>
            )}

            {template.field_type === "checkbox" && (
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id={fieldId}
                  checked={value === "true"}
                  onChange={(e) =>
                    onFormFieldValuesChange({
                      ...formFieldValues,
                      [template.id]: e.target.checked ? "true" : "false",
                    })
                  }
                  className="rounded"
                />
                <Label htmlFor={fieldId} className="cursor-pointer">
                  {template.placeholder || t("form.customFields.checkBox")}
                </Label>
              </div>
            )}

            {template.help_text && (
              <p className="text-xs text-muted-foreground">{template.help_text}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
