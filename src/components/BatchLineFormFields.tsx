/**
 * BatchLineFormFields — per-line custom field renderer with its OWN isolated
 * on-demand branch-loading state.
 *
 * DOC-100 pt.1: previously a pure prop-passthrough component fed a single
 * category-wide `optionBranches` array pre-fetched eagerly by the parent for
 * every option value in the category (ExpenseBatchForm's old
 * `branchesByCategoryId`). That model breaks down the moment two lines share
 * a template but pick different parent option values (Line 1 = ABC,
 * Line 2 = XYZ) and is exactly the unbounded-download pattern the rest of
 * this feature already moved off of for the single-expense and shared-field
 * flows.
 *
 * Each mounted instance of this component (one per batch line, keyed by the
 * line's clientId in ExpenseBatchForm) now owns its own
 * useOnDemandOptionBranches instance, so branch state for Line 1's "ABC"
 * selection can never leak into Line 2's "XYZ" selection even when both
 * lines are on the same category/template.
 */

import { useEffect } from "react";
import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import { useOnDemandOptionBranches } from "@/hooks/useOnDemandOptionBranches";
import type { BatchFieldAssignment } from "@/lib/batchFieldPlan";

type BatchLineFormFieldsProps = {
  /**
   * Per-line assignments resolved from the central BatchFieldPlan for this
   * line's category. Provided by ExpenseBatchForm — do not fetch here.
   */
  assignments: BatchFieldAssignment[];
  /** The category ID these assignments belong to — used only to detect a
   *  category change on this line so stale branch state can be reset. */
  categoryId: string;
  /** DOC-100 pt.2: this line's own clientId, used to scope every rendered
   *  field's DOM id (CategoryFormFieldsSection's instanceId) so two lines on
   *  the same template never render duplicate ids. */
  lineId: string;
  formFieldValues: Record<string, string>;
  branchValues: Record<string, string>;
  onFormFieldValuesChange: (values: Record<string, string>) => void;
  onBranchValuesChange: (values: Record<string, string>) => void;
  allowConditionalDropdown: boolean;
  allowNested: boolean;
  organizationId: string;
  userId?: string | null;
  /** Fires whenever this line's most recent branch fetch failed vs. succeeded,
   *  so the parent can block submission rather than silently treating a
   *  failed fetch as "no conditional fields configured". */
  onLoadErrorChange?: (hasError: boolean) => void;
};

export function BatchLineFormFields({
  assignments,
  categoryId,
  lineId,
  formFieldValues,
  branchValues,
  onFormFieldValuesChange,
  onBranchValuesChange,
  allowConditionalDropdown,
  allowNested,
  organizationId,
  userId,
  onLoadErrorChange,
}: BatchLineFormFieldsProps) {
  const { optionBranches, selectOptionValue, reset, hasError, isResolvedFor, isLoadingFor, hasErrorFor } =
    useOnDemandOptionBranches(organizationId);

  // Reset stale branches whenever this line's category changes, then
  // re-derive from whatever is ALREADY selected — covers initial mount,
  // a duplicated/copied line (which carries over formFieldValues), and any
  // other restored-state case, without re-running on every keystroke of an
  // unrelated field on this same line.
  useEffect(() => {
    reset();
    if (!allowConditionalDropdown) return;
    for (const a of assignments) {
      if (a.template?.field_type !== "select") continue;
      const selected = formFieldValues[a.template.id];
      if (selected) void selectOptionValue(a.template.id, selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, categoryId, allowConditionalDropdown]);

  useEffect(() => {
    onLoadErrorChange?.(hasError);
  }, [hasError, onLoadErrorChange]);

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
      optionBranches={allowConditionalDropdown ? optionBranches : []}
      branchValues={branchValues}
      onBranchValuesChange={onBranchValuesChange}
      allowNested={allowNested}
      organizationId={organizationId}
      userId={userId}
      onSelectOptionValue={allowConditionalDropdown ? selectOptionValue : undefined}
      instanceId={lineId}
      isOptionResolved={allowConditionalDropdown ? isResolvedFor : undefined}
      isOptionLoading={allowConditionalDropdown ? isLoadingFor : undefined}
      isOptionErrored={allowConditionalDropdown ? hasErrorFor : undefined}
    />
  );
}
