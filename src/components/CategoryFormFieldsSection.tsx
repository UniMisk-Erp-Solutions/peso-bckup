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
}: CategoryFormFieldsSectionProps) {
  const { t } = useTranslation("expenses");

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
        const fieldId = `field-${template.id}`;
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
                    idPrefix={`tpl-${template.id}`}
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
