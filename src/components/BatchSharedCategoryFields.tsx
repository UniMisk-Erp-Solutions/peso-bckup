import { useEffect, useState } from "react";
import { ExpenseService } from "@/services/ExpenseService";
import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";
import type { SharedBatchField } from "@/lib/batchFieldPlan";

type BatchSharedCategoryFieldsProps = {
  organizationId: string;
  /** One deduped shared field from the BatchFieldPlan */
  sharedField: SharedBatchField;
  /** Field values keyed by template ID */
  fields: Record<string, string>;
  /** Branch values keyed by branch ID */
  branches: Record<string, string>;
  onFieldsChange: (fields: Record<string, string>) => void;
  onBranchesChange: (branches: Record<string, string>) => void;
  allowConditionalDropdown: boolean;
  allowNested: boolean;
  userId?: string | null;
};

export function BatchSharedCategoryFields({
  organizationId,
  sharedField,
  fields,
  branches,
  onFieldsChange,
  onBranchesChange,
  allowConditionalDropdown,
  allowNested,
  userId,
}: BatchSharedCategoryFieldsProps) {
  const [optionBranches, setOptionBranches] = useState<OptionBranchDefinition[]>([]);

  useEffect(() => {
    if (!allowConditionalDropdown || sharedField.assignment.template?.field_type !== "select") {
      setOptionBranches([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await ExpenseService.fetchOptionBranchesForTemplates(
        organizationId,
        [sharedField.templateId],
      );
      if (!cancelled) setOptionBranches(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, sharedField.templateId, sharedField.assignment.template?.field_type, allowConditionalDropdown]);

  const categoryLabel =
    sharedField.categoryNames.length > 0
      ? sharedField.categoryNames.join(", ")
      : "this batch";

  return (
    <div className="rounded-md border border-primary/25 bg-primary/5 p-3 space-y-2">
      <p className="text-xs font-medium text-primary">
        Shared for all &quot;{categoryLabel}&quot; lines in this batch (answer once)
      </p>
      <CategoryFormFieldsSection
        categoryFormFields={[sharedField.assignment]}
        formFieldValues={fields}
        onFormFieldValuesChange={onFieldsChange}
        optionBranches={allowConditionalDropdown ? optionBranches : []}
        branchValues={branches}
        onBranchValuesChange={onBranchesChange}
        allowNested={allowNested}
        organizationId={organizationId}
        userId={userId}
      />
    </div>
  );
}
