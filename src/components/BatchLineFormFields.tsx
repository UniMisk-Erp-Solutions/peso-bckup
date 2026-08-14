/**
 * BatchLineFormFields — presentation-only per-line custom field renderer.
 *
 * This component does NOT fetch from the database and does NOT classify fields
 * as shared vs per-line. The caller (ExpenseBatchForm) must pre-resolve
 * per-line assignments from the central BatchFieldPlan and pass them in.
 *
 * Once-per-batch templates are excluded at the plan level and will never
 * appear in the `assignments` prop.
 */

import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";
import type { BatchFieldAssignment } from "@/lib/batchFieldPlan";

type BatchLineFormFieldsProps = {
  /**
   * Per-line assignments resolved from the central BatchFieldPlan for this
   * line's category. Provided by ExpenseBatchForm — do not fetch here.
   */
  assignments: BatchFieldAssignment[];
  /** Branch definitions pre-fetched centrally. Pass [] when conditional dropdowns are disabled. */
  optionBranches: OptionBranchDefinition[];
  formFieldValues: Record<string, string>;
  branchValues: Record<string, string>;
  onFormFieldValuesChange: (values: Record<string, string>) => void;
  onBranchValuesChange: (values: Record<string, string>) => void;
  allowNested: boolean;
  organizationId: string;
  userId?: string | null;
};

export function BatchLineFormFields({
  assignments,
  optionBranches,
  formFieldValues,
  branchValues,
  onFormFieldValuesChange,
  onBranchValuesChange,
  allowNested,
  organizationId,
  userId,
}: BatchLineFormFieldsProps) {
  // Normalize the assignment shape to satisfy CategoryFormFieldsSection's
  // strict template type. BatchFieldAssignment.template has optional fields
  // (nullable) from the DB; we coerce them to the expected non-nullable shape.
  const normalized = assignments.map((a) => ({
    ...a,
    required: a.required ?? null,
    template: {
      ...a.template,
      id: a.template.id,
      name: a.template.name ?? "",
      field_type: a.template.field_type ?? "text",
      required: Boolean(a.required ?? a.template.required),
      placeholder: a.template.placeholder ?? null,
      help_text: a.template.help_text ?? null,
      options: Array.isArray(a.template.options) ? (a.template.options as string[]) : null,
    },
  }));

  return (
    <CategoryFormFieldsSection
      categoryFormFields={normalized}
      formFieldValues={formFieldValues}
      onFormFieldValuesChange={onFormFieldValuesChange}
      optionBranches={optionBranches}
      branchValues={branchValues}
      onBranchValuesChange={onBranchValuesChange}
      allowNested={allowNested}
      organizationId={organizationId}
      userId={userId}
    />
  );
}
