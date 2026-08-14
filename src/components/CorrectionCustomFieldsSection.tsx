import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

interface CorrectionCustomFieldsSectionProps {
  categoryFormFields: Array<{
    template: {
      id: string;
      name: string;
      field_type: string;
      required: boolean;
      placeholder?: string | null;
      help_text?: string | null;
      validation_rules?: { min?: number; max?: number } | null;
      options?: string[] | null;
    };
    required?: boolean | null;
  }>;
  formFieldValues: Record<string, string>;
  onFormFieldValuesChange: (values: Record<string, string>) => void;
  optionBranches: OptionBranchDefinition[];
  branchValues: Record<string, string>;
  onBranchValuesChange: (values: Record<string, string>) => void;
  allowNested?: boolean;
  organizationId?: string | null;
  userId?: string | null;
}

export function CorrectionCustomFieldsSection(props: CorrectionCustomFieldsSectionProps) {
  if (props.categoryFormFields.length === 0) return null;
  return (
    <div className="border-t pt-3 space-y-3">
      <p className="text-xs font-medium text-muted-foreground">Custom form fields</p>
      <CategoryFormFieldsSection
        categoryFormFields={props.categoryFormFields}
        formFieldValues={props.formFieldValues}
        onFormFieldValuesChange={props.onFormFieldValuesChange}
        optionBranches={props.optionBranches}
        branchValues={props.branchValues}
        onBranchValuesChange={props.onBranchValuesChange}
        allowNested={props.allowNested ?? false}
        organizationId={props.organizationId}
        userId={props.userId}
      />
    </div>
  );
}
