import { describe, expect, it } from "vitest";
import {
  getVisibleBranchIds,
  getVisibleBranches,
  validateVisibleBranchFields,
} from "@/lib/conditionalFormFields";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

const parentTemplateId = "tpl-1";

const branches: OptionBranchDefinition[] = [
  {
    id: "b-mode",
    organization_id: "org",
    parent_template_id: parentTemplateId,
    parent_option_value: "Travel",
    parent_branch_id: null,
    field_key: "mode",
    name: "Mode",
    field_type: "select",
    required: true,
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
    options: ["Flight", "Train"],
    display_order: 0,
  },
  {
    id: "b-airline",
    organization_id: "org",
    parent_template_id: parentTemplateId,
    parent_option_value: "Flight",
    parent_branch_id: "b-mode",
    field_key: "airline",
    name: "Airline",
    field_type: "text",
    required: true,
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
    options: null,
    display_order: 0,
  },
];

describe("conditionalFormFields", () => {
  it("shows root branch when parent option selected", () => {
    const visible = getVisibleBranches(
      branches,
      { [parentTemplateId]: "Travel" },
      {},
      true,
    );
    expect(visible.map((v) => v.branch.id)).toEqual(["b-mode"]);
  });

  it("shows nested branch when child select value set", () => {
    const visible = getVisibleBranches(
      branches,
      { [parentTemplateId]: "Travel" },
      { "b-mode": "Flight" },
      true,
    );
    expect(visible.map((v) => v.branch.id)).toContain("b-airline");
  });

  it("clears nested visibility when parent option changes", () => {
    const ids = getVisibleBranchIds(
      branches,
      { [parentTemplateId]: "Supplies" },
      { "b-mode": "Flight" },
      true,
    );
    expect(ids.has("b-mode")).toBe(false);
    expect(ids.has("b-airline")).toBe(false);
  });

  it("validates required visible branches", () => {
    const result = validateVisibleBranchFields(
      branches,
      { [parentTemplateId]: "Travel" },
      { "b-mode": "Flight" },
      true,
    );
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("Airline");

    const ok = validateVisibleBranchFields(
      branches,
      { [parentTemplateId]: "Travel" },
      { "b-mode": "Flight", "b-airline": "IndiGo" },
      true,
    );
    expect(ok.valid).toBe(true);
  });
});
