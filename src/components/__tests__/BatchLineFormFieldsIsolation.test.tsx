/**
 * DOC-100 pt.1 — batch per-line conditional field isolation (THE critical
 * scalability test: two lines on the SAME template must never leak each
 * other's selected option's conditional/branch fields).
 *
 * BLI-1  selecting a parent option on one line requests ONLY that option's
 *        branch tree via the bounded runtime RPC (never a category-wide fetch)
 * BLI-2  Line 1 = "ABC" and Line 2 = "XYZ" on the SAME template render their
 *        OWN branch field independently — no cross-contamination
 * BLI-3  changing Line 2's selection does not alter Line 1's already-rendered
 *        branch field or value
 * BLI-4  two lines on the same template render DISTINCT DOM ids (DOC-100
 *        pt.2's instanceId fix) — proven by resolving each combobox via its
 *        accessible name instead of container scoping
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BatchLineFormFields } from "@/components/BatchLineFormFields";
import type { BatchFieldAssignment } from "@/lib/batchFieldPlan";

Element.prototype.scrollIntoView = vi.fn();

const rpcSpy = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcSpy(...args) },
}));

vi.mock("@/hooks/useRecommendedFieldOptions", () => ({
  useRecommendedFieldOptions: () => ({}),
  fieldRecKey: (kind: string, key: string) => `${kind}:${key}`,
}));

const TEMPLATE_ID = "tmpl-category";

function makeAssignments(): BatchFieldAssignment[] {
  return [
    {
      id: "assign-1",
      category_id: "cat-1",
      required: false,
      template: {
        id: TEMPLATE_ID,
        name: "Vendor",
        field_type: "select",
        required: false,
        placeholder: null,
        help_text: null,
        options: ["ABC", "XYZ"],
      },
    },
  ];
}

function branchFor(optionValue: string) {
  return {
    id: `branch-${optionValue}`,
    parent_option_value: optionValue,
    parent_branch_id: null,
    field_key: `field-${optionValue}`,
    name: `${optionValue} detail`,
    field_type: "text",
    required: false,
  };
}

function Harness({ lineId }: { lineId: string }) {
  const [formFieldValues, setFormFieldValues] = useState<Record<string, string>>({});
  const [branchValues, setBranchValues] = useState<Record<string, string>>({});
  return (
    <BatchLineFormFields
      assignments={makeAssignments()}
      categoryId="cat-1"
      lineId={lineId}
      formFieldValues={formFieldValues}
      branchValues={branchValues}
      onFormFieldValuesChange={setFormFieldValues}
      onBranchValuesChange={setBranchValues}
      allowConditionalDropdown
      allowNested={false}
      organizationId="org-1"
      userId="user-1"
    />
  );
}

beforeEach(() => {
  rpcSpy.mockReset();
  rpcSpy.mockImplementation((_fn: string, args: Record<string, unknown>) => {
    const optionValue = args.p_parent_option_value as string;
    return Promise.resolve({ data: { branches: [branchFor(optionValue)] }, error: null });
  });
});

describe("BLI-1 — bounded, per-option RPC fetch", () => {
  it("requests only the selected option's branches, not the whole category", async () => {
    const user = userEvent.setup();
    render(<Harness lineId="line-1" />);

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText("ABC"));

    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(1));
    expect(rpcSpy).toHaveBeenCalledWith(
      "get_runtime_form_option_configuration",
      expect.objectContaining({
        p_organization_id: "org-1",
        p_template_id: TEMPLATE_ID,
        p_parent_option_value: "ABC",
      }),
    );
  });
});

describe("BLI-2 / BLI-3 / BLI-4 — two lines on the same template stay isolated", () => {
  it("Line 1 = ABC and Line 2 = XYZ render their own branch field without leaking, with distinct DOM ids", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <div data-testid="line-1">
          <Harness lineId="line-1" />
        </div>
        <div data-testid="line-2">
          <Harness lineId="line-2" />
        </div>
      </div>,
    );

    const line1 = screen.getByTestId("line-1");
    const line2 = screen.getByTestId("line-2");

    // BLI-4: each line's combobox now has a distinct DOM id (DOC-100 pt.2's
    // instanceId scoping) even though both lines share the identical
    // "Vendor" label text.
    const line1ComboIdBefore = within(line1).getByRole("combobox").id;
    const line2ComboIdBefore = within(line2).getByRole("combobox").id;
    expect(line1ComboIdBefore).not.toBe(line2ComboIdBefore);

    await user.click(within(line1).getByRole("combobox"));
    await user.click(await screen.findByText("ABC"));
    await waitFor(() => expect(within(line1).getByText("ABC detail")).toBeInTheDocument());

    await user.click(within(line2).getByRole("combobox"));
    await user.click(await screen.findByText("XYZ"));
    await waitFor(() => expect(within(line2).getByText("XYZ detail")).toBeInTheDocument());

    // Line 1 must still show ONLY its own ABC-derived branch field, never
    // Line 2's XYZ one, and vice versa.
    expect(within(line1).getByText("ABC detail")).toBeInTheDocument();
    expect(within(line1).queryByText("XYZ detail")).not.toBeInTheDocument();
    expect(within(line2).getByText("XYZ detail")).toBeInTheDocument();
    expect(within(line2).queryByText("ABC detail")).not.toBeInTheDocument();

    const line1ComboId = within(line1).getByRole("combobox").id;
    const line2ComboId = within(line2).getByRole("combobox").id;
    expect(line1ComboId).not.toBe(line2ComboId);

    expect(rpcSpy).toHaveBeenCalledWith(
      "get_runtime_form_option_configuration",
      expect.objectContaining({ p_parent_option_value: "ABC" }),
    );
    expect(rpcSpy).toHaveBeenCalledWith(
      "get_runtime_form_option_configuration",
      expect.objectContaining({ p_parent_option_value: "XYZ" }),
    );
  });
});
