import { useEffect } from "react";
import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import { useOnDemandOptionBranches } from "@/hooks/useOnDemandOptionBranches";
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
  /** Fires whenever this shared field's most recent branch fetch failed vs.
   *  succeeded, so the parent can block submission rather than silently
   *  treating a failed fetch as "no conditional fields configured". */
  onLoadErrorChange?: (hasError: boolean) => void;
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
  onLoadErrorChange,
}: BatchSharedCategoryFieldsProps) {
  // DOC-097 hotfix pt.3: no more eager whole-template branch fetch --
  // branches for the shared select field load on demand for whichever
  // option is actually picked (see onSelectOptionValue below).
  const { optionBranches, selectOptionValue, reset, hasError, isResolvedFor, isLoadingFor, hasErrorFor } =
    useOnDemandOptionBranches(organizationId);

  useEffect(() => {
    onLoadErrorChange?.(hasError);
  }, [hasError, onLoadErrorChange]);

  useEffect(() => {
    reset();
    if (allowConditionalDropdown && sharedField.assignment.template?.field_type === "select") {
      const preselected = fields[sharedField.templateId];
      if (preselected) void selectOptionValue(sharedField.templateId, preselected);
    }
    // Only re-run when the shared field itself (or the org/toggle) changes --
    // NOT on every `fields` edit, which would otherwise reset the cache on
    // every keystroke of an unrelated field in the same batch line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        onSelectOptionValue={allowConditionalDropdown ? selectOptionValue : undefined}
        isOptionResolved={allowConditionalDropdown ? isResolvedFor : undefined}
        isOptionLoading={allowConditionalDropdown ? isLoadingFor : undefined}
        isOptionErrored={allowConditionalDropdown ? hasErrorFor : undefined}
      />
    </div>
  );
}
