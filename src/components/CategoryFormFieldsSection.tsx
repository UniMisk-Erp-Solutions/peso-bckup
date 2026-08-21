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
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useRecommendedFieldOptions, fieldRecKey } from "@/hooks/useRecommendedFieldOptions";
import type { FormFieldKind } from "@/lib/recommendedFormFieldOptions";

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
}: CategoryFormFieldsSectionProps) {
  const { t } = useTranslation("expenses");
  const idScope = instanceId ? `${instanceId}-` : "";

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

  if (categoryFormFields.length === 0) return null;

  const handleTemplateSelectChange = (templateId: string, val: string) => {
    const nextTemplate = { ...formFieldValues, [templateId]: val };
    onFormFieldValuesChange(nextTemplate);
    // DOC-097 hotfix pt.3: this option's own branches may not be loaded yet
    // (they're now fetched on-demand, not eagerly for every option) --
    // buildInitialBranchValues below only clears/derives from whatever is
    // ALREADY in optionBranches, so it correctly no-ops until the caller's
    // fetch resolves and a re-render supplies the real branches.
    onSelectOptionValue?.(templateId, val);
    const nextBranch = buildInitialBranchValues(
      optionBranches,
      nextTemplate,
      allowNested,
      branchValues,
    );
    onBranchValuesChange(nextBranch);
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
              <Input
                id={fieldId}
                value={value}
                onChange={(e) =>
                  onFormFieldValuesChange({
                    ...formFieldValues,
                    [template.id]: e.target.value,
                  })
                }
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
              <Textarea
                id={fieldId}
                value={value}
                onChange={(e) =>
                  onFormFieldValuesChange({
                    ...formFieldValues,
                    [template.id]: e.target.value,
                  })
                }
                placeholder={template.placeholder || ""}
                required={isRequired}
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
                {optionBranches.some((b) => b.parent_template_id === template.id) && (
                  <BranchFieldInputs
                    visibleBranches={visibleBranches.filter((v) =>
                      isBranchUnderTemplate(v.branch, template.id, optionBranches),
                    )}
                    branchValues={branchValues}
                    onBranchChange={handleBranchChange}
                    idPrefix={`tpl-${idScope}${template.id}`}
                    recommendedByKey={recommendedByKey}
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
