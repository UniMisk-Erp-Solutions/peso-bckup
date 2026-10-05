/**
 * INCIDENT hotfix (2026-09) — CategoryFormFieldsSection's branch-value
 * reconciliation effect.
 *
 * Before the fix, `handleTemplateSelectChange` synchronously recomputed
 * `branchValues` against whatever `optionBranches` happened to hold at
 * click time — which, for an on-demand fetch, is either stale (still
 * belongs to the PREVIOUSLY selected option) or empty (fetch not started
 * yet). Both looked identical to "this option has no conditional fields"
 * and silently wiped any already-typed branch value.
 *
 * The fix moved recomputation into a `useEffect` that only runs once
 * EVERY currently-selected select-type template's on-demand config is
 * confirmed `ready` via the optional `isOptionResolved` prop. These tests
 * exercise that reconciliation gate directly against the component, using
 * a hand-rolled in-memory resolution-status map instead of the real
 * useOnDemandOptionBranches hook, so the assertions are about the
 * component's contract with that prop rather than the hook's own
 * behavior (covered separately in useOnDemandOptionBranches.test.ts).
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

vi.mock("@/hooks/useRecommendedFieldOptions", () => ({
  useRecommendedFieldOptions: () => ({}),
  fieldRecKey: (kind: string, key: string) => `${kind}:${key}`,
}));

const PROJECT_UID_TEMPLATE = "tmpl-project-uid";
const OTHER_TEMPLATE = "tmpl-other-select";

function categoryFormFields() {
  return [
    {
      template: {
        id: PROJECT_UID_TEMPLATE,
        name: "Project Unique ID",
        field_type: "select" as const,
        required: false,
        options: ["UID-OLD", "UID-NEW"],
      },
      required: false,
    },
    {
      template: {
        id: OTHER_TEMPLATE,
        name: "Other Select",
        field_type: "select" as const,
        required: false,
        options: ["X", "Y"],
      },
      required: false,
    },
  ];
}

function branchFor(optionValue: string, id = `branch-${optionValue}`): OptionBranchDefinition {
  return {
    id,
    organization_id: "org-1",
    parent_template_id: PROJECT_UID_TEMPLATE,
    parent_option_value: optionValue,
    parent_branch_id: null,
    field_key: `field_${optionValue}`,
    name: `${optionValue} Project ID`,
    field_type: "text",
    required: true,
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
    options: null,
    display_order: 0,
  };
}

function otherBranchFor(optionValue: string): OptionBranchDefinition {
  return {
    id: `other-branch-${optionValue}`,
    organization_id: "org-1",
    parent_template_id: OTHER_TEMPLATE,
    parent_option_value: optionValue,
    parent_branch_id: null,
    field_key: `other_field_${optionValue}`,
    name: `${optionValue} Other Detail`,
    field_type: "text",
    required: false,
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
    options: null,
    display_order: 0,
  };
}

/** A hand-rolled in-memory resolution status map, standing in for
 *  useOnDemandOptionBranches's statusByTemplate — lets each test control
 *  exactly which (templateId, value) pairs are "resolved" independent of
 *  any real fetch. */
function Harness({
  initialFormFieldValues = {},
  initialBranchValues = {},
  initialOptionBranches = [],
  resolvedPairs = new Set<string>(),
  onFormFieldValuesChangeSpy,
  onBranchValuesChangeSpy,
}: {
  initialFormFieldValues?: Record<string, string>;
  initialBranchValues?: Record<string, string>;
  initialOptionBranches?: OptionBranchDefinition[];
  resolvedPairs?: Set<string>;
  onFormFieldValuesChangeSpy?: (v: Record<string, string>) => void;
  onBranchValuesChangeSpy?: (v: Record<string, string>) => void;
}) {
  const [formFieldValues, setFormFieldValues] = useState(initialFormFieldValues);
  const [branchValues, setBranchValues] = useState(initialBranchValues);
  const [optionBranches] = useState(initialOptionBranches);

  const isOptionResolved = (templateId: string, value: string) => resolvedPairs.has(`${templateId}::${value}`);

  return (
    <CategoryFormFieldsSection
      categoryFormFields={categoryFormFields()}
      formFieldValues={formFieldValues}
      onFormFieldValuesChange={(v) => {
        onFormFieldValuesChangeSpy?.(v);
        setFormFieldValues(v);
      }}
      optionBranches={optionBranches}
      branchValues={branchValues}
      onBranchValuesChange={(v) => {
        onBranchValuesChangeSpy?.(v);
        setBranchValues(v);
      }}
      allowNested={false}
      isOptionResolved={isOptionResolved}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CategoryFormFieldsSection — reconciliation gate (Defect D)", () => {
  it("does NOT wipe branchValues while the newly-selected option's config is unresolved", async () => {
    const onBranchValuesChangeSpy = vi.fn();

    render(
      <Harness
        initialFormFieldValues={{ [PROJECT_UID_TEMPLATE]: "UID-NEW" }}
        // A stale branch value for a DIFFERENT (previously selected) option
        // is already sitting in branchValues.
        initialBranchValues={{ "branch-UID-OLD": "12345" }}
        // optionBranches has not resolved for UID-NEW yet — empty, exactly
        // like an in-flight or not-yet-started fetch.
        initialOptionBranches={[]}
        resolvedPairs={new Set()}
        onBranchValuesChangeSpy={onBranchValuesChangeSpy}
      />,
    );

    // Give the effect a chance to run (it runs on mount too).
    await waitFor(() => expect(screen.getByText("Project Unique ID")).toBeInTheDocument());

    // Nothing should have wiped/reconciled branchValues — isOptionResolved
    // says UID-NEW isn't ready yet, so the effect must be a no-op.
    expect(onBranchValuesChangeSpy).not.toHaveBeenCalled();
  });

  it("reconciles branchValues once the selection's config becomes resolved, showing the correct branch", async () => {
    const onBranchValuesChangeSpy = vi.fn();

    function ControlledHarness() {
      const [resolved, setResolved] = useState(false);
      const [optionBranches, setOptionBranches] = useState<OptionBranchDefinition[]>([]);
      const [formFieldValues, setFormFieldValues] = useState<Record<string, string>>({
        [PROJECT_UID_TEMPLATE]: "UID-NEW",
      });
      const [branchValues, setBranchValues] = useState<Record<string, string>>({
        "branch-UID-OLD": "12345",
      });

      return (
        <div>
          <button
            type="button"
            onClick={() => {
              // Simulate the fetch landing: config for UID-NEW is now known.
              setOptionBranches([branchFor("UID-NEW")]);
              setResolved(true);
            }}
          >
            resolve-fetch
          </button>
          <CategoryFormFieldsSection
            categoryFormFields={categoryFormFields()}
            formFieldValues={formFieldValues}
            onFormFieldValuesChange={setFormFieldValues}
            optionBranches={optionBranches}
            branchValues={branchValues}
            onBranchValuesChange={(v) => {
              onBranchValuesChangeSpy(v);
              setBranchValues(v);
            }}
            allowNested={false}
            isOptionResolved={(templateId, value) =>
              resolved && templateId === PROJECT_UID_TEMPLATE && value === "UID-NEW"
            }
          />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<ControlledHarness />);

    // Not yet resolved: no reconciliation, stale field not shown, spy unused.
    expect(screen.queryByText("UID-NEW Project ID")).not.toBeInTheDocument();
    expect(onBranchValuesChangeSpy).not.toHaveBeenCalled();

    await user.click(screen.getByText("resolve-fetch"));

    await waitFor(() => expect(onBranchValuesChangeSpy).toHaveBeenCalled());
    // The newly-visible UID-NEW branch field is now rendered and present in
    // the reconciled branchValues (buildInitialBranchValues keeps existing
    // values and seeds defaults for newly-visible branches — since this
    // branch has no default, it is present with the empty seed logic only
    // if visible; assert the FIELD renders, which is the user-facing proof).
    expect(await screen.findByText("UID-NEW Project ID")).toBeInTheDocument();
  });
});

describe("CategoryFormFieldsSection — no premature wipe of an unrelated template's answer", () => {
  it("keeps another already-answered template's branch value untouched while a different selection is still loading", async () => {
    const onBranchValuesChangeSpy = vi.fn();

    function ControlledHarness() {
      const [formFieldValues] = useState<Record<string, string>>({
        [PROJECT_UID_TEMPLATE]: "UID-NEW", // still unresolved
        [OTHER_TEMPLATE]: "X", // already answered and resolved
      });
      const [branchValues, setBranchValues] = useState<Record<string, string>>({
        "other-branch-X": "already typed answer",
      });
      const [optionBranches] = useState<OptionBranchDefinition[]>([otherBranchFor("X")]);

      return (
        <CategoryFormFieldsSection
          categoryFormFields={categoryFormFields()}
          formFieldValues={formFieldValues}
          onFormFieldValuesChange={() => {}}
          optionBranches={optionBranches}
          branchValues={branchValues}
          onBranchValuesChange={(v) => {
            onBranchValuesChangeSpy(v);
            setBranchValues(v);
          }}
          allowNested={false}
          // PROJECT_UID_TEMPLATE's "UID-NEW" is never in resolvedPairs —
          // simulates its fetch still being in flight — while OTHER_TEMPLATE's
          // "X" IS resolved.
          isOptionResolved={(templateId, value) =>
            templateId === OTHER_TEMPLATE && value === "X"
          }
        />
      );
    }

    render(<ControlledHarness />);

    // The reconciliation effect must stay a no-op overall (gated by the
    // UNRESOLVED PROJECT_UID_TEMPLATE selection) so it never touches
    // branchValues at all -- in particular it must never reset the
    // OTHER_TEMPLATE answer to {} or drop it.
    await waitFor(() => expect(screen.getByText("Other Select")).toBeInTheDocument());
    expect(onBranchValuesChangeSpy).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("already typed answer")).toBeInTheDocument();
  });
});
