/**
 * Unit tests for subFieldPresets.ts pure helpers (DOC-062)
 *
 * Tests:
 * 1.  countPresetFields — flat schema
 * 2.  countPresetFields — nested schema
 * 3.  buildPresetFromParentOption — strips DB IDs
 * 4.  buildPresetFromParentOption — strips parent option values
 * 5.  buildPresetFromParentOption — retains field_key
 * 6.  buildPresetFromParentOption — retains nested hierarchy
 * 7.  buildPresetFromParentOption — structure-only drops choices
 * 8.  buildPresetFromParentOption — includeOptions copies choices
 * 9.  clonePresetForParentOption — generates new localIds
 * 10. clonePresetForParentOption — sets dbId to null
 * 11. clonePresetForParentOption — root branches have correct parent_option_value
 * 12. clonePresetForParentOption — nested branch has correct parent_branch_local_id
 * 13. mergePresetIntoParentOption — adds missing field_key
 * 14. mergePresetIntoParentOption — does not duplicate existing field_key
 * 15. mergePresetIntoParentOption — preserves per-option dropdown choices
 * 16. syncPresetIntoParentOption — updates name/type/required from preset
 * 17. syncPresetIntoParentOption — preserves per-option dropdown choices
 * 18. syncPresetIntoParentOption — adds missing keys
 * 19. replaceParentOptionWithPreset — removes old root and descendants
 * 20. replaceParentOptionWithPreset — clones preset structure in
 * 21. applyPresetToParentOptions — mode merge — applies to unconfigured only
 * 22. applyPresetToParentOptions — mode sync — updates all selected
 * 23. applyPresetToParentOptions — returns correct appliedTo / skipped counts
 * 24. applyDefaultPresetToNewOptions — applies to genuinely new options only
 * 25. applyDefaultPresetToNewOptions — no-op when preset is empty
 * 26. getUnconfiguredOptions — returns options with no root branches
 * 27. findPresetConflicts — detects type_mismatch
 * 28. findPresetConflicts — detects name_mismatch
 * 29. findPresetConflicts — no conflict when types and names match
 * 30. validatePresetSchema — error on blank name
 * 31. validatePresetSchema — error on duplicate field_key
 * 32. validatePresetSchema — clean schema passes
 * 33. normalizePresetFieldKeys — slugifies blank keys
 * 34. serializePresetSchema / deserializePresetSchema — roundtrip
 * 35. buildPresetMatrix — correct cell isComplete for select
 * 36. buildPresetMatrix — isConfigured false when no named branches
 * 37. buildPresetMatrix — 0 choice count for non-select fields
 * 38. applyPresetToParentOptions — does not share object references
 */

import { describe, it, expect } from "vitest";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";
import {
  buildPresetFromParentOption,
  clonePresetForParentOption,
  mergePresetIntoParentOption,
  syncPresetIntoParentOption,
  replaceParentOptionWithPreset,
  applyPresetToParentOptions,
  applyDefaultPresetToNewOptions,
  getUnconfiguredOptions,
  findPresetConflicts,
  validatePresetSchema,
  normalizePresetFieldKeys,
  serializePresetSchema,
  deserializePresetSchema,
  buildPresetMatrix,
  countPresetFields,
  type ReusableSubFieldDefinition,
} from "../subFieldPresets";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDraft(
  overrides: Partial<DraftOptionBranch> & {
    localId: string;
    parent_option_value: string;
  },
): DraftOptionBranch {
  return {
    localId: overrides.localId,
    dbId: overrides.dbId ?? "db-" + overrides.localId,
    parent_option_value: overrides.parent_option_value,
    parent_branch_local_id: overrides.parent_branch_local_id ?? null,
    field_key: overrides.field_key ?? overrides.localId + "_key",
    name: overrides.name ?? "Field " + overrides.localId,
    field_type: overrides.field_type ?? "text",
    required: overrides.required ?? false,
    placeholder: overrides.placeholder ?? "",
    help_text: overrides.help_text ?? "",
    options: overrides.options ?? [],
    display_order: overrides.display_order ?? 0,
  };
}

function makeSchema(
  overrides: Partial<ReusableSubFieldDefinition> & { fieldKey: string; name: string },
): ReusableSubFieldDefinition {
  return {
    localSchemaId: "schema-" + overrides.fieldKey,
    fieldKey: overrides.fieldKey,
    name: overrides.name,
    fieldType: overrides.fieldType ?? "text",
    required: overrides.required ?? false,
    placeholder: overrides.placeholder ?? "",
    helpText: overrides.helpText ?? "",
    options: overrides.options ?? [],
    displayOrder: overrides.displayOrder ?? 0,
    children: overrides.children ?? [],
  };
}

const projectIdSchema = makeSchema({ fieldKey: "project_id", name: "Project ID", fieldType: "select", displayOrder: 0 });
const projectNameSchema = makeSchema({ fieldKey: "project_name", name: "Project Name", fieldType: "select", displayOrder: 1 });

// ── Test setup — reused drafts ─────────────────────────────────────────────────

const rootA = makeDraft({ localId: "r1", parent_option_value: "OptionA", field_key: "project_id", name: "Project ID", field_type: "select", options: ["17451"], display_order: 0 });
const rootA2 = makeDraft({ localId: "r2", parent_option_value: "OptionA", field_key: "project_name", name: "Project Name", field_type: "select", options: ["Polycab"], display_order: 1 });
const childA = makeDraft({ localId: "c1", parent_option_value: "OptionA", parent_branch_local_id: "r1", field_key: "site_id", name: "Site ID", field_type: "text", display_order: 0 });
const rootB = makeDraft({ localId: "rB", parent_option_value: "OptionB", field_key: "project_id", name: "Project ID", field_type: "select", options: ["999"], display_order: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// 1-2. countPresetFields
// ─────────────────────────────────────────────────────────────────────────────

describe("countPresetFields", () => {
  it("1. flat schema", () => {
    expect(countPresetFields([projectIdSchema, projectNameSchema])).toBe(2);
  });

  it("2. nested schema", () => {
    const nested = makeSchema({ fieldKey: "parent", name: "Parent", children: [projectIdSchema, projectNameSchema] });
    expect(countPresetFields([nested])).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3-8. buildPresetFromParentOption
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPresetFromParentOption", () => {
  const rootDrafts = [rootA, rootA2];
  const allDrafts = [rootA, rootA2, childA, rootB];

  it("3. strips DB IDs", () => {
    const schema = buildPresetFromParentOption(rootDrafts, allDrafts);
    schema.forEach((s) => {
      expect((s as unknown as { dbId?: unknown }).dbId).toBeUndefined();
    });
  });

  it("4. strips parent option values", () => {
    const schema = buildPresetFromParentOption(rootDrafts, allDrafts);
    schema.forEach((s) => {
      expect((s as unknown as { parent_option_value?: string }).parent_option_value).toBeUndefined();
    });
  });

  it("5. retains field_key", () => {
    const schema = buildPresetFromParentOption(rootDrafts, allDrafts);
    expect(schema[0].fieldKey).toBe("project_id");
    expect(schema[1].fieldKey).toBe("project_name");
  });

  it("6. retains nested hierarchy", () => {
    const schema = buildPresetFromParentOption(rootDrafts, allDrafts);
    const pid = schema.find((s) => s.fieldKey === "project_id")!;
    expect(pid.children).toHaveLength(1);
    expect(pid.children[0].fieldKey).toBe("site_id");
  });

  it("7. structure-only strips choices by default", () => {
    const schema = buildPresetFromParentOption(rootDrafts, allDrafts);
    expect(schema[0].options).toEqual([]);
    expect(schema[1].options).toEqual([]);
  });

  it("8. includeOptions copies choices", () => {
    const schema = buildPresetFromParentOption(rootDrafts, allDrafts, true);
    expect(schema[0].options).toEqual(["17451"]);
    expect(schema[1].options).toEqual(["Polycab"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9-12. clonePresetForParentOption
// ─────────────────────────────────────────────────────────────────────────────

describe("clonePresetForParentOption", () => {
  const schema = [
    makeSchema({ fieldKey: "project_id", name: "Project ID", fieldType: "select", displayOrder: 0, children: [makeSchema({ fieldKey: "site_id", name: "Site", displayOrder: 0 })] }),
    makeSchema({ fieldKey: "project_name", name: "Project Name", displayOrder: 1 }),
  ];

  it("9. generates new localIds", () => {
    const a = clonePresetForParentOption(schema, "OptA");
    const b = clonePresetForParentOption(schema, "OptA");
    const aIds = a.map((d) => d.localId);
    const bIds = b.map((d) => d.localId);
    aIds.forEach((id, i) => expect(id).not.toBe(bIds[i]));
  });

  it("10. sets dbId to null", () => {
    const drafts = clonePresetForParentOption(schema, "OptA");
    drafts.forEach((d) => expect(d.dbId).toBeNull());
  });

  it("11. root branches use target parentOptionValue", () => {
    const drafts = clonePresetForParentOption(schema, "NewOption");
    const roots = drafts.filter((d) => d.parent_branch_local_id === null);
    roots.forEach((r) => expect(r.parent_option_value).toBe("NewOption"));
  });

  it("12. nested branch has correct parent_branch_local_id", () => {
    const drafts = clonePresetForParentOption(schema, "OptA");
    const rootPid = drafts.find((d) => d.field_key === "project_id" && !d.parent_branch_local_id)!;
    const child = drafts.find((d) => d.field_key === "site_id")!;
    expect(child.parent_branch_local_id).toBe(rootPid.localId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13-15. mergePresetIntoParentOption
// ─────────────────────────────────────────────────────────────────────────────

describe("mergePresetIntoParentOption", () => {
  const existing = [rootA]; // only project_id, missing project_name
  const schema = [projectIdSchema, projectNameSchema];

  it("13. adds missing field_key", () => {
    const result = mergePresetIntoParentOption(existing, schema, "OptionA");
    const rootKeys = result.filter((d) => !d.parent_branch_local_id && d.parent_option_value === "OptionA").map((d) => d.field_key);
    expect(rootKeys).toContain("project_name");
  });

  it("14. does not duplicate existing field_key", () => {
    const result = mergePresetIntoParentOption(existing, schema, "OptionA");
    const pidCount = result.filter((d) => d.field_key === "project_id" && d.parent_option_value === "OptionA" && !d.parent_branch_local_id).length;
    expect(pidCount).toBe(1);
  });

  it("15. preserves per-option dropdown choices on existing branch", () => {
    const result = mergePresetIntoParentOption(existing, schema, "OptionA");
    const pid = result.find((d) => d.field_key === "project_id" && d.parent_option_value === "OptionA")!;
    expect(pid.options).toEqual(["17451"]); // preserved from rootA
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16-18. syncPresetIntoParentOption
// ─────────────────────────────────────────────────────────────────────────────

describe("syncPresetIntoParentOption", () => {
  const outdatedDraft = makeDraft({ localId: "r1", parent_option_value: "OptionA", field_key: "project_id", name: "Old Project ID", field_type: "text", options: ["17451"] });
  const schema = [makeSchema({ fieldKey: "project_id", name: "Project ID", fieldType: "select", required: true }), projectNameSchema];

  it("16. updates name, type, required from preset", () => {
    const result = syncPresetIntoParentOption([outdatedDraft], schema, "OptionA");
    const pid = result.find((d) => d.field_key === "project_id" && d.parent_option_value === "OptionA")!;
    expect(pid.name).toBe("Project ID");
    expect(pid.field_type).toBe("select");
    expect(pid.required).toBe(true);
  });

  it("17. preserves per-option dropdown choices", () => {
    const result = syncPresetIntoParentOption([outdatedDraft], schema, "OptionA");
    const pid = result.find((d) => d.field_key === "project_id" && d.parent_option_value === "OptionA")!;
    expect(pid.options).toEqual(["17451"]); // preserved
  });

  it("18. adds missing keys", () => {
    const result = syncPresetIntoParentOption([outdatedDraft], schema, "OptionA");
    const keys = result.filter((d) => !d.parent_branch_local_id && d.parent_option_value === "OptionA").map((d) => d.field_key);
    expect(keys).toContain("project_name");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19-20. replaceParentOptionWithPreset
// ─────────────────────────────────────────────────────────────────────────────

describe("replaceParentOptionWithPreset", () => {
  const allDrafts = [rootA, rootA2, childA, rootB];
  const schema = [projectIdSchema];

  it("19. removes old root and all descendants for the option", () => {
    const result = replaceParentOptionWithPreset(allDrafts, schema, "OptionA");
    // rootA, rootA2, childA all belong to OptionA — should be gone
    expect(result.find((d) => d.localId === "r1")).toBeUndefined();
    expect(result.find((d) => d.localId === "r2")).toBeUndefined();
    expect(result.find((d) => d.localId === "c1")).toBeUndefined();
  });

  it("20. clones preset structure in with new localIds", () => {
    const result = replaceParentOptionWithPreset(allDrafts, schema, "OptionA");
    const newRoots = result.filter((d) => !d.parent_branch_local_id && d.parent_option_value === "OptionA");
    expect(newRoots).toHaveLength(1);
    expect(newRoots[0].field_key).toBe("project_id");
    expect(newRoots[0].dbId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21-23. applyPresetToParentOptions
// ─────────────────────────────────────────────────────────────────────────────

describe("applyPresetToParentOptions", () => {
  const allDrafts = [rootA, rootA2, rootB]; // OptionA has both; OptionB has only project_id; OptionC unconfigured
  const schema = [projectIdSchema, projectNameSchema];

  it("21. merge — skips fully-configured options", () => {
    const { appliedTo, skipped } = applyPresetToParentOptions(allDrafts, schema, ["OptionA"], "merge");
    expect(appliedTo).toBe(0);
    expect(skipped).toBe(1);
  });

  it("22. sync — updates all selected options regardless", () => {
    const { appliedTo } = applyPresetToParentOptions(allDrafts, schema, ["OptionA", "OptionB"], "sync");
    expect(appliedTo).toBe(2);
  });

  it("23. returns correct appliedTo and skipped counts", () => {
    // OptionA already complete, OptionB missing project_name
    const { appliedTo, skipped } = applyPresetToParentOptions(allDrafts, schema, ["OptionA", "OptionB"], "merge");
    expect(appliedTo).toBe(1); // OptionB
    expect(skipped).toBe(1);   // OptionA
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 24-25. applyDefaultPresetToNewOptions
// ─────────────────────────────────────────────────────────────────────────────

describe("applyDefaultPresetToNewOptions", () => {
  const schema = [projectIdSchema, projectNameSchema];

  it("24. applies to genuinely new options only", () => {
    const existing = ["OptionA"];
    const allNew = ["OptionA", "OptionB", "OptionC"];
    const { appliedOptions } = applyDefaultPresetToNewOptions(existing, allNew, [], schema);
    expect(appliedOptions).toEqual(["OptionB", "OptionC"]);
  });

  it("25. no-op when preset schema is empty", () => {
    const { drafts, appliedOptions } = applyDefaultPresetToNewOptions([], ["OptionX"], [], []);
    expect(appliedOptions).toHaveLength(0);
    expect(drafts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 26. getUnconfiguredOptions
// ─────────────────────────────────────────────────────────────────────────────

describe("getUnconfiguredOptions", () => {
  it("26. returns options with no named root branches", () => {
    const allOptions = ["OptionA", "OptionB", "OptionC"];
    const allDrafts = [rootA]; // only OptionA has named roots
    const unconfigured = getUnconfiguredOptions(allOptions, allDrafts);
    expect(unconfigured).toEqual(["OptionB", "OptionC"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27-29. findPresetConflicts
// ─────────────────────────────────────────────────────────────────────────────

describe("findPresetConflicts", () => {
  const typeMismatch = makeDraft({ localId: "tx", parent_option_value: "OptionA", field_key: "project_id", name: "Project ID", field_type: "text" });
  const nameMismatch = makeDraft({ localId: "nm", parent_option_value: "OptionA", field_key: "project_id", name: "PID", field_type: "select" });
  const clean = makeDraft({ localId: "cl", parent_option_value: "OptionA", field_key: "project_id", name: "Project ID", field_type: "select" });

  it("27. detects type_mismatch", () => {
    const conflicts = findPresetConflicts([typeMismatch], [projectIdSchema], "OptionA");
    expect(conflicts.some((c) => c.conflictKind === "type_mismatch")).toBe(true);
  });

  it("28. detects name_mismatch", () => {
    const conflicts = findPresetConflicts([nameMismatch], [projectIdSchema], "OptionA");
    expect(conflicts.some((c) => c.conflictKind === "name_mismatch")).toBe(true);
  });

  it("29. no conflict when types and names match", () => {
    const conflicts = findPresetConflicts([clean], [projectIdSchema], "OptionA");
    expect(conflicts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 30-32. validatePresetSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("validatePresetSchema", () => {
  it("30. error on blank name", () => {
    const errors = validatePresetSchema([makeSchema({ fieldKey: "pk", name: "" })]);
    expect(errors.some((e) => e.message.includes("name is required"))).toBe(true);
  });

  it("31. error on duplicate field_key", () => {
    const errors = validatePresetSchema([
      makeSchema({ fieldKey: "project_id", name: "A" }),
      makeSchema({ fieldKey: "project_id", name: "B" }),
    ]);
    expect(errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
  });

  it("32. clean schema passes", () => {
    const errors = validatePresetSchema([projectIdSchema, projectNameSchema]);
    expect(errors).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 33. normalizePresetFieldKeys
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizePresetFieldKeys", () => {
  it("33. slugifies blank keys from name", () => {
    const schema = [makeSchema({ fieldKey: "", name: "Project Name" })];
    const normalized = normalizePresetFieldKeys(schema);
    expect(normalized[0].fieldKey).toBe("project_name");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 34. serializePresetSchema / deserializePresetSchema roundtrip
// ─────────────────────────────────────────────────────────────────────────────

describe("serialize/deserialize roundtrip", () => {
  it("34. roundtrip preserves all fields", () => {
    const original = [
      makeSchema({ fieldKey: "project_id", name: "Project ID", fieldType: "select", required: true, options: ["17451"], displayOrder: 0, children: [makeSchema({ fieldKey: "site_id", name: "Site", displayOrder: 0 })] }),
    ];
    const serialized = serializePresetSchema(original);
    const deserialized = deserializePresetSchema(serialized);
    expect(deserialized[0].fieldKey).toBe("project_id");
    expect(deserialized[0].fieldType).toBe("select");
    expect(deserialized[0].required).toBe(true);
    expect(deserialized[0].options).toEqual(["17451"]);
    expect(deserialized[0].children[0].fieldKey).toBe("site_id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 35-37. buildPresetMatrix
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPresetMatrix", () => {
  const schema = [projectIdSchema, projectNameSchema];
  const allDrafts = [rootA, rootA2, rootB]; // OptionA: both; OptionB: only project_id

  it("35. cell isComplete for select requires at least 1 choice when required", () => {
    const requiredPidSchema = makeSchema({ fieldKey: "project_id", name: "Project ID", fieldType: "select", required: true });
    const matrix = buildPresetMatrix(["OptionA"], [requiredPidSchema], [makeDraft({ localId: "rx", parent_option_value: "OptionA", field_key: "project_id", field_type: "select", options: [] })]);
    expect(matrix[0].cells[0].isComplete).toBe(false);
  });

  it("36. isConfigured false when no named root branches", () => {
    const unnamedDraft = makeDraft({ localId: "ux", parent_option_value: "OptionC", field_key: "project_id", name: "" });
    const matrix = buildPresetMatrix(["OptionC"], schema, [unnamedDraft]);
    expect(matrix[0].isConfigured).toBe(false);
  });

  it("37. choiceCount is 0 for text field", () => {
    const textDraft = makeDraft({ localId: "tx", parent_option_value: "OptionX", field_key: "project_id", field_type: "text", options: ["ignored"] });
    const matrix = buildPresetMatrix(["OptionX"], [projectIdSchema], [textDraft]);
    expect(matrix[0].cells[0].choiceCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 38. No shared object references between parent options
// ─────────────────────────────────────────────────────────────────────────────

describe("object reference isolation", () => {
  it("38. applyPresetToParentOptions does not share options arrays", () => {
    const schema = [makeSchema({ fieldKey: "project_id", name: "Project ID", fieldType: "select", options: ["shared"] })];
    const { drafts } = applyPresetToParentOptions([], schema, ["OptX", "OptY"], "merge");
    const x = drafts.find((d) => d.parent_option_value === "OptX")!;
    const y = drafts.find((d) => d.parent_option_value === "OptY")!;
    x.options.push("mutation");
    expect(y.options).not.toContain("mutation");
  });
});
