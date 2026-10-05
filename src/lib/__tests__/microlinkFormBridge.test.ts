import { describe, expect, it } from "vitest";

import {
  buildMicroLinkExpenseSnapshotV1,
  microLinkFormStateFromExpenseForm,
  snapshotBusinessValues,
  visibleBusinessValues,
} from "@/lib/microlinkExpenseSnapshot";

const T_UID = "51181324-68cc-4174-bbe0-4834e5e22c48";
const T_FROM = "5308e883-78a4-4bee-abed-67f4e0e5fee8";
const T_TO = "ca80b2f7-0199-4f9a-b425-230e84aecd12";
const T_OTHER = "99999999-9999-9999-9999-999999999999";

const travellingFields = [
  { template: { id: T_UID, name: "Project Unique ID", field_type: "select", required: true } },
  { template: { id: T_FROM, name: "From location", field_type: "text", required: true } },
  { template: { id: T_TO, name: "To location", field_type: "text", required: true } },
];

const core = {
  title: "Site visit",
  destination: "Halol",
  tripStart: "2026-09-09",
  category: "Travelling (Public and Private Transport)",
  totalAmount: 250,
};

describe("ExpenseForm state -> MicroLink snapshot bridge", () => {
  it("reads the project, from and to values out of the form's own state", () => {
    const { form, visibility } = microLinkFormStateFromExpenseForm({
      core,
      categoryFormFields: travellingFields,
      formFieldValues: {
        [T_UID]: "202605M117",
        [T_FROM]: "Ahmedabad",
        [T_TO]: "Gandhinagar",
      },
      branchValues: {},
      optionBranches: [],
    });

    expect(visibility).toEqual({ projectUniqueId: true, fromLocation: true, toLocation: true });
    expect(form.projectUniqueId).toBe("202605M117");
    expect(form.fromLocation).toBe("Ahmedabad");
    expect(form.toLocation).toBe("Gandhinagar");

    const snap = buildMicroLinkExpenseSnapshotV1(form, {
      idempotencyKey: "k", visibility, configResolved: true,
    });
    expect(snapshotBusinessValues(snap)).toEqual(visibleBusinessValues(form, visibility));
  });

  it("picks branch values belonging ONLY to the currently selected project", () => {
    const branches = [
      { id: "b-A-id", field_key: "project_id", parent_option_value: "PROJECT-A" },
      { id: "b-A-name", field_key: "project_name", parent_option_value: "PROJECT-A" },
      { id: "b-B-id", field_key: "project_id", parent_option_value: "PROJECT-B" },
      { id: "b-B-name", field_key: "project_name", parent_option_value: "PROJECT-B" },
    ];
    // The employee visited B, then came back to A. Stale B values linger in state.
    const { form } = microLinkFormStateFromExpenseForm({
      core,
      categoryFormFields: travellingFields,
      formFieldValues: { [T_UID]: "PROJECT-A", [T_FROM]: "A", [T_TO]: "B" },
      branchValues: {
        "b-A-id": "111", "b-A-name": "Alpha",
        "b-B-id": "222", "b-B-name": "Bravo",
      },
      optionBranches: branches,
    });

    expect(form.projectId).toBe("111");
    expect(form.projectName).toBe("Alpha");
    // the superseded project's values must not travel
    expect(form.projectId).not.toBe("222");
    expect(form.projectName).not.toBe("Bravo");
  });

  it("marks a MicroLink field invisible when the category does not render it", () => {
    const { visibility, form } = microLinkFormStateFromExpenseForm({
      core: { ...core, category: "Hotel/Guest House" },
      categoryFormFields: [travellingFields[0]], // project only
      formFieldValues: { [T_UID]: "202605M117" },
      branchValues: {},
      optionBranches: [],
    });
    expect(visibility).toEqual({ projectUniqueId: true, fromLocation: false, toLocation: false });

    const snap = buildMicroLinkExpenseSnapshotV1(form, {
      idempotencyKey: "k", visibility, configResolved: true,
    });
    expect(snap.microlink.from_location).toBeUndefined();
    expect(snap.microlink.to_location).toBeUndefined();
    expect(snap.microlink.project_unique_id).toBe("202605M117");
  });

  it("carries any other template the category rendered as an additional field", () => {
    const { form } = microLinkFormStateFromExpenseForm({
      core,
      categoryFormFields: [
        ...travellingFields,
        { template: { id: T_OTHER, name: "Vehicle Number", field_type: "text" } },
      ],
      formFieldValues: {
        [T_UID]: "P", [T_FROM]: "A", [T_TO]: "B", [T_OTHER]: "GJ-01-AB-1234",
      },
      branchValues: {},
      optionBranches: [],
    });
    expect(form.additionalFields).toEqual([
      { templateId: T_OTHER, value: "GJ-01-AB-1234" },
    ]);
  });

  it("never puts a MicroLink field into additional_fields (no double-write)", () => {
    const { form, visibility } = microLinkFormStateFromExpenseForm({
      core,
      categoryFormFields: travellingFields,
      formFieldValues: { [T_UID]: "P", [T_FROM]: "A", [T_TO]: "B" },
      branchValues: {},
      optionBranches: [],
    });
    const snap = buildMicroLinkExpenseSnapshotV1(form, {
      idempotencyKey: "k", visibility, configResolved: true,
    });
    const ids = snap.additional_fields.map((f) => f.template_id);
    expect(ids).not.toContain(T_UID);
    expect(ids).not.toContain(T_FROM);
    expect(ids).not.toContain(T_TO);
  });

  it("§31 the 6818 shape survives the whole bridge unchanged", () => {
    const { form, visibility } = microLinkFormStateFromExpenseForm({
      core: {
        title: "NRO",
        destination: "Client site",
        tripStart: "2026-09-01",
        category: "Travelling (Public and Private Transport)",
        totalAmount: 40,
      },
      categoryFormFields: travellingFields,
      formFieldValues: {
        [T_UID]: "202605M117", [T_FROM]: "Ahmedabad", [T_TO]: "Vadodara",
      },
      branchValues: {},
      optionBranches: [],
    });

    const snap = buildMicroLinkExpenseSnapshotV1(form, {
      idempotencyKey: "6818-key", visibility, configResolved: true,
    });

    // exactly what the employee could see, in one object, before any network call
    expect(snap.microlink).toEqual({
      project_unique_id: "202605M117",
      from_location: "Ahmedabad",
      to_location: "Vadodara",
    });
    expect(snap.core.total_amount).toBe(40);
    expect(snap.core.title).toBe("NRO");
  });
});
