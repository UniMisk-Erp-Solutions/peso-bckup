/**
 * INCIDENT — Project Unique ID / Project ID / Project Name data loss.
 *
 * CHARACTERIZATION test: proves the exact MECHANISM of the dominant root
 * cause at the pure-function level. `getVisibleBranchIds` /
 * `buildExpenseCustomFieldPayload` are the real functions ExpenseForm.tsx's
 * `saveFormFieldValues` calls (see ExpenseForm.tsx:1345-1362) — given
 * `optionBranches = []` (which is exactly what the edit/resubmit bootstrap
 * used to leave permanently, deterministically, in place — it never
 * re-fetched branch DEFINITIONS for an already-selected parent option, only
 * previously-saved branch VALUES), these functions have no way to know a
 * complete, correct, previously-saved Project ID / Project Name answer is
 * still valid, and correctly-per-their-contract drop it. That is intrinsic
 * to these functions given that input — it is not something to "fix" at
 * this layer, and this test intentionally continues to demonstrate the drop
 * even after the incident fix.
 *
 * The actual fix is at the CALLER: ExpenseForm.tsx's edit bootstrap now
 * loads existing template values BEFORE calling fetchCategoryFormFields,
 * passing them as `preserveFormValues` so its already-correct prefetch path
 * fetches real branch definitions for the saved selection (see
 * ExpenseForm.tsx fetchExpense, "INCIDENT hotfix (2026-09)"), and
 * saveFormFieldValues/pre-submit validation now BLOCK outright (rather than
 * silently computing visibleBranchIds = new Set()) whenever any currently-
 * selected select-type template's config is not confirmed `ready` via
 * useOnDemandOptionBranches's isResolvedFor. The end-to-end regression test
 * exercising THAT fix (mounting ExpenseForm in edit mode, asserting the
 * definitions are prefetched and a save can never emit an incomplete
 * payload) is tracked separately as an integration test.
 *
 * This is also the exact mechanism that explains the batch-path evidence: a
 * batch-originated expense's OWN creation-time shared-field capture
 * (BatchSharedCategoryFields / applyBatchFieldPlanToLines) is structurally
 * sound — it awaits a fresh branch fetch before every advance/submit — but a
 * LATER resubmit of one rejected line goes through this same
 * ExpenseForm.tsx edit bootstrap, which is where the dependents actually
 * used to get dropped.
 */
import { describe, it, expect } from "vitest";
import { getVisibleBranchIds } from "@/lib/conditionalFormFields";
import { buildExpenseCustomFieldPayload } from "@/lib/expenseFormFieldPayload";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

const PROJECT_UID_TEMPLATE_ID = "51181324-68cc-4174-bbe0-4834e5e22c48";
const PROJECT_ID_BRANCH_ID = "branch-project-id";
const PROJECT_NAME_BRANCH_ID = "branch-project-name";
const SELECTED_UID_VALUE = "PROJ-0001";

function realBranchDefinitions(): OptionBranchDefinition[] {
  return [
    {
      id: PROJECT_ID_BRANCH_ID,
      organization_id: "org-1",
      parent_template_id: PROJECT_UID_TEMPLATE_ID,
      parent_option_value: SELECTED_UID_VALUE,
      parent_branch_id: null,
      field_key: "project_id",
      name: "Project ID",
      field_type: "text",
      required: true,
      placeholder: null,
      help_text: null,
      default_value: null,
      validation_rules: null,
      options: null,
      display_order: 0,
    },
    {
      id: PROJECT_NAME_BRANCH_ID,
      organization_id: "org-1",
      parent_template_id: PROJECT_UID_TEMPLATE_ID,
      parent_option_value: SELECTED_UID_VALUE,
      parent_branch_id: null,
      field_key: "project_name",
      name: "Project Name",
      field_type: "text",
      required: true,
      placeholder: null,
      help_text: null,
      default_value: null,
      validation_rules: null,
      options: null,
      display_order: 1,
    },
  ];
}

describe("Edit/resubmit bootstrap must not drop a complete existing custom-field answer", () => {
  it("characterizes the mechanism: optionBranches=[] makes a complete existing answer indistinguishable from nothing to save", () => {
    const formFieldValues = { [PROJECT_UID_TEMPLATE_ID]: SELECTED_UID_VALUE };
    const branchValues = {
      [PROJECT_ID_BRANCH_ID]: "PID-EXISTING",
      [PROJECT_NAME_BRANCH_ID]: "Existing Project",
    };

    // ExpenseForm.tsx's edit bootstrap (:909) calls fetchCategoryFormFields
    // with no options argument at all, so branch DEFINITIONS are never
    // fetched for the value that was already selected — optionBranches stays
    // permanently empty for this render, even though the real branch
    // definitions for SELECTED_UID_VALUE do exist (see realBranchDefinitions()
    // above, standing in for what the DB actually has).
    const optionBranchesAsLoadedOnEditBootstrap: OptionBranchDefinition[] = [];
    const allowConditionalDropdown = true;

    // Reproduces ExpenseForm.tsx:1324-1332 verbatim.
    const visibleBranchIds =
      allowConditionalDropdown && optionBranchesAsLoadedOnEditBootstrap.length > 0
        ? getVisibleBranchIds(
            optionBranchesAsLoadedOnEditBootstrap,
            formFieldValues,
            branchValues,
            false,
          )
        : new Set<string>();

    // Reproduces ExpenseForm.tsx:1337-1341 verbatim.
    const payload = buildExpenseCustomFieldPayload({
      templateValues: formFieldValues,
      branchValues,
      visibleBranchIds,
    });

    const savedBranchIds = payload
      .filter((row) => row.branch_field_id)
      .map((row) => row.branch_field_id);

    // This is the bug's mechanism, not a desired outcome: with no branch
    // definitions available, both previously-saved values vanish from the
    // payload with no error raised anywhere in this computation. The fix
    // is to never let ExpenseForm.tsx reach this call with `optionBranches`
    // in this state for a template that has a selected value — see the
    // module docblock above.
    expect(savedBranchIds).toEqual([]);
  });

  it("control: once real branch definitions ARE available, the same computation correctly keeps both values", () => {
    const formFieldValues = { [PROJECT_UID_TEMPLATE_ID]: SELECTED_UID_VALUE };
    const branchValues = {
      [PROJECT_ID_BRANCH_ID]: "PID-EXISTING",
      [PROJECT_NAME_BRANCH_ID]: "Existing Project",
    };
    const optionBranches = realBranchDefinitions();

    const visibleBranchIds = getVisibleBranchIds(optionBranches, formFieldValues, branchValues, false);
    const payload = buildExpenseCustomFieldPayload({
      templateValues: formFieldValues,
      branchValues,
      visibleBranchIds,
    });
    const savedBranchIds = payload.filter((row) => row.branch_field_id).map((row) => row.branch_field_id);

    expect(savedBranchIds).toEqual(
      expect.arrayContaining([PROJECT_ID_BRANCH_ID, PROJECT_NAME_BRANCH_ID]),
    );
  });
});
