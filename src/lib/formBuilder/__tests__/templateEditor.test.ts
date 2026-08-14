/**
 * Unit tests for templateEditor.ts pure helpers (Phase 1)
 *
 * Tests:
 * 1.  paginateItems returns correct page
 * 2.  pageCount handles edge cases
 * 3.  buildIndexedOptions filters and retains original index
 * 4.  buildIndexedOptions empty search returns all
 * 5.  buildBranchIndexes — root lookup correct
 * 6.  buildBranchIndexes — child lookup correct
 * 7.  buildBranchIndexes — branch count includes nested
 * 8.  validateOptions — blank issue
 * 9.  validateOptions — duplicate issue (case-insensitive)
 * 10. validateOptions — clean options produce no issues
 * 11. renameParentOption — updates option value
 * 12. renameParentOption — migrates root drafts to new value
 * 13. renameParentOption — does not touch nested drafts
 * 14. deleteParentOption — removes option from array
 * 15. deleteParentOption — removes root drafts for option
 * 16. deleteParentOption — cascades to nested descendants
 * 17. deleteParentOption — leaves other options' drafts intact
 * 18. countBranchesForOption — correct count with nested
 * 19. validateTemplate — error when name blank
 * 20. validateTemplate — error when select has no options
 * 21. validateTemplate — error for blank option
 * 22. validateTemplate — error for duplicate option
 * 23. validateTemplate — error for select branch with no choices
 * 24. validateTemplate — clean select passes
 * 25. buildCleanedOptions — deduplicates case-insensitively
 * 26. parseBulkOptionValues — splits by newline and comma
 * 27. mergeBulkOptions — skips duplicates and blanks
 * 28. mergeBulkOptions — returns correct added/skipped counts
 * 29. isSnapshotDirty — clean when identical
 * 30. isSnapshotDirty — dirty when name changes
 */

import { describe, it, expect } from "vitest";
import {
  paginateItems,
  pageCount,
  buildIndexedOptions,
  buildBranchIndexes,
  validateOptions,
  renameParentOption,
  deleteParentOption,
  countBranchesForOption,
  validateTemplate,
  buildCleanedOptions,
  parseBulkOptionValues,
  mergeBulkOptions,
  makeSnapshot,
  isSnapshotDirty,
} from "../templateEditor";
import type { DraftOptionBranch } from "@/lib/optionBranchPersistence";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDraft(
  overrides: Partial<DraftOptionBranch> & {
    localId: string;
    parent_option_value: string;
  },
): DraftOptionBranch {
  return {
    localId: overrides.localId,
    dbId: null,
    parent_option_value: overrides.parent_option_value,
    parent_branch_local_id: overrides.parent_branch_local_id ?? null,
    field_key: overrides.field_key ?? "fk",
    name: overrides.name ?? "Field",
    field_type: overrides.field_type ?? "text",
    required: overrides.required ?? false,
    placeholder: overrides.placeholder ?? "",
    help_text: overrides.help_text ?? "",
    options: overrides.options ?? [],
    display_order: overrides.display_order ?? 0,
  };
}

const baseSnapshot = {
  name: "Test",
  type: "text",
  required: false,
  placeholder: "",
  defaultValue: "",
  helpText: "",
  min: "",
  max: "",
  options: [],
  branchDrafts: [],
};

// ── Pagination ─────────────────────────────────────────────────────────────────

describe("paginateItems", () => {
  it("1. returns the correct page", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(paginateItems(items, 2, 25)).toEqual(Array.from({ length: 25 }, (_, i) => i + 25));
  });

  it("2a. pageCount rounds up", () => {
    expect(pageCount(101, 50)).toBe(3);
  });

  it("2b. pageCount returns 1 for 0 items", () => {
    expect(pageCount(0, 50)).toBe(1);
  });
});

// ── buildIndexedOptions ────────────────────────────────────────────────────────

describe("buildIndexedOptions", () => {
  const options = ["Alpha", "Beta", "Gamma", "alpha-2"];

  it("3. filters and retains original index", () => {
    const result = buildIndexedOptions(options, "alp");
    expect(result).toEqual([
      { value: "Alpha", originalIndex: 0 },
      { value: "alpha-2", originalIndex: 3 },
    ]);
  });

  it("4. empty search returns all", () => {
    expect(buildIndexedOptions(options, "")).toHaveLength(4);
  });
});

// ── buildBranchIndexes ─────────────────────────────────────────────────────────

describe("buildBranchIndexes", () => {
  const root1 = makeDraft({ localId: "r1", parent_option_value: "A" });
  const root2 = makeDraft({ localId: "r2", parent_option_value: "A" });
  const child1 = makeDraft({ localId: "c1", parent_option_value: "A", parent_branch_local_id: "r1" });
  const child2 = makeDraft({ localId: "c2", parent_option_value: "A", parent_branch_local_id: "c1" });
  const rootB = makeDraft({ localId: "rB", parent_option_value: "B" });
  const drafts = [root1, root2, child1, child2, rootB];

  it("5. root lookup correct", () => {
    const { rootsByParentOption } = buildBranchIndexes(drafts);
    expect(rootsByParentOption.get("A")?.map((d) => d.localId)).toEqual(["r1", "r2"]);
    expect(rootsByParentOption.get("B")?.map((d) => d.localId)).toEqual(["rB"]);
  });

  it("6. child lookup correct", () => {
    const { childrenByParentLocalId } = buildBranchIndexes(drafts);
    expect(childrenByParentLocalId.get("r1")?.map((d) => d.localId)).toEqual(["c1"]);
    expect(childrenByParentLocalId.get("c1")?.map((d) => d.localId)).toEqual(["c2"]);
  });

  it("7. branch count includes nested", () => {
    const { branchCountByParentOption } = buildBranchIndexes(drafts);
    // A: r1, r2, c1 (child of r1), c2 (child of c1) = 4
    expect(branchCountByParentOption.get("A")).toBe(4);
    expect(branchCountByParentOption.get("B")).toBe(1);
  });
});

// ── validateOptions ────────────────────────────────────────────────────────────

describe("validateOptions", () => {
  it("8. blank issue", () => {
    const issues = validateOptions(["  ", "Good"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("blank");
    expect(issues[0].originalIndex).toBe(0);
  });

  it("9. duplicate issue (case-insensitive)", () => {
    const issues = validateOptions(["Alpha", "alpha"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("duplicate");
  });

  it("10. clean options produce no issues", () => {
    expect(validateOptions(["A", "B", "C"])).toHaveLength(0);
  });
});

// ── renameParentOption ─────────────────────────────────────────────────────────

describe("renameParentOption", () => {
  const opts = ["A", "B"];
  const rootA = makeDraft({ localId: "r1", parent_option_value: "A" });
  const nestedA = makeDraft({ localId: "n1", parent_option_value: "sub_x", parent_branch_local_id: "r1" });
  const rootB = makeDraft({ localId: "r2", parent_option_value: "B" });
  const drafts = [rootA, nestedA, rootB];

  it("11. updates option value in array", () => {
    const { options } = renameParentOption(opts, drafts, 0, "A-renamed");
    expect(options[0]).toBe("A-renamed");
    expect(options[1]).toBe("B");
  });

  it("12. migrates root drafts to new value", () => {
    const { branchDrafts } = renameParentOption(opts, drafts, 0, "A-renamed");
    expect(branchDrafts.find((d) => d.localId === "r1")?.parent_option_value).toBe("A-renamed");
  });

  it("13. does not touch nested drafts (parent_branch_local_id set)", () => {
    const { branchDrafts } = renameParentOption(opts, drafts, 0, "A-renamed");
    // nestedA.parent_option_value is "sub_x" (a sub-option), should be unchanged
    expect(branchDrafts.find((d) => d.localId === "n1")?.parent_option_value).toBe("sub_x");
  });
});

// ── deleteParentOption ─────────────────────────────────────────────────────────

describe("deleteParentOption", () => {
  const opts = ["A", "B", "C"];
  const rootA1 = makeDraft({ localId: "r1", parent_option_value: "A" });
  const rootA2 = makeDraft({ localId: "r2", parent_option_value: "A" });
  const childA = makeDraft({ localId: "c1", parent_option_value: "A", parent_branch_local_id: "r1" });
  const deepChild = makeDraft({ localId: "d1", parent_option_value: "A", parent_branch_local_id: "c1" });
  const rootB = makeDraft({ localId: "rB", parent_option_value: "B" });
  const drafts = [rootA1, rootA2, childA, deepChild, rootB];

  it("14. removes option from array", () => {
    const { options } = deleteParentOption(opts, drafts, 0);
    expect(options).toEqual(["B", "C"]);
  });

  it("15. removes root drafts for the deleted option", () => {
    const { branchDrafts } = deleteParentOption(opts, drafts, 0);
    expect(branchDrafts.find((d) => d.localId === "r1")).toBeUndefined();
    expect(branchDrafts.find((d) => d.localId === "r2")).toBeUndefined();
  });

  it("16. cascades to nested descendants", () => {
    const { branchDrafts } = deleteParentOption(opts, drafts, 0);
    expect(branchDrafts.find((d) => d.localId === "c1")).toBeUndefined();
    expect(branchDrafts.find((d) => d.localId === "d1")).toBeUndefined();
  });

  it("17. leaves other options' drafts intact", () => {
    const { branchDrafts } = deleteParentOption(opts, drafts, 0);
    expect(branchDrafts.find((d) => d.localId === "rB")).toBeDefined();
  });
});

// ── countBranchesForOption ─────────────────────────────────────────────────────

describe("countBranchesForOption", () => {
  it("18. correct count with nested", () => {
    const root = makeDraft({ localId: "r", parent_option_value: "X" });
    const child = makeDraft({ localId: "c", parent_option_value: "X", parent_branch_local_id: "r" });
    expect(countBranchesForOption("X", [root, child])).toBe(2);
    expect(countBranchesForOption("X", [root])).toBe(1);
    expect(countBranchesForOption("Y", [root, child])).toBe(0);
  });
});

// ── validateTemplate ───────────────────────────────────────────────────────────

describe("validateTemplate", () => {
  const noDrafts: DraftOptionBranch[] = [];

  it("19. error when name blank", () => {
    const issues = validateTemplate({ name: "  ", type: "text", options: [], branchDrafts: noDrafts });
    expect(issues.some((i) => i.section === "basics" && i.severity === "error")).toBe(true);
  });

  it("20. error when select has no options", () => {
    const issues = validateTemplate({ name: "Field", type: "select", options: [], branchDrafts: noDrafts });
    expect(issues.some((i) => i.section === "options" && i.severity === "error")).toBe(true);
  });

  it("21. error for blank option", () => {
    const issues = validateTemplate({ name: "F", type: "select", options: ["  ", "Real"], branchDrafts: noDrafts });
    expect(issues.some((i) => i.section === "options" && i.message.includes("blank"))).toBe(true);
  });

  it("22. error for duplicate option", () => {
    const issues = validateTemplate({ name: "F", type: "select", options: ["A", "a"], branchDrafts: noDrafts });
    expect(issues.some((i) => i.section === "options" && i.message.includes("Duplicate"))).toBe(true);
  });

  it("23. error for select branch with no choices", () => {
    const branch = makeDraft({ localId: "b1", parent_option_value: "A", name: "Sub", field_type: "select", options: [] });
    const issues = validateTemplate({ name: "F", type: "select", options: ["A"], branchDrafts: [branch] });
    expect(issues.some((i) => i.section === "dependent" && i.message.includes("Sub"))).toBe(true);
  });

  it("24. clean select passes validation", () => {
    const issues = validateTemplate({ name: "Field", type: "select", options: ["A", "B"], branchDrafts: noDrafts });
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

// ── buildCleanedOptions ────────────────────────────────────────────────────────

describe("buildCleanedOptions", () => {
  it("25. deduplicates case-insensitively", () => {
    const result = buildCleanedOptions(["Alpha", "alpha", "", "Beta"]);
    expect(result).toEqual(["Alpha", "Beta"]);
  });
});

// ── parseBulkOptionValues ──────────────────────────────────────────────────────

describe("parseBulkOptionValues", () => {
  it("26. splits by newline and comma", () => {
    const result = parseBulkOptionValues("A\nB,C\n  D  ");
    expect(result).toEqual(["A", "B", "C", "D"]);
  });
});

// ── mergeBulkOptions ───────────────────────────────────────────────────────────

describe("mergeBulkOptions", () => {
  it("27. skips duplicates and blanks", () => {
    const { next } = mergeBulkOptions(["A"], ["A", "B", ""]);
    expect(next).toEqual(["A", "B"]);
  });

  it("28. returns correct added/skipped counts", () => {
    const { added, skipped } = mergeBulkOptions(["A"], ["A", "B", "  "]);
    expect(added).toBe(1);
    expect(skipped).toBe(2); // "A" duplicate + blank
  });
});

// ── isSnapshotDirty ────────────────────────────────────────────────────────────

describe("isSnapshotDirty", () => {
  it("29. clean when identical", () => {
    const baseline = makeSnapshot(baseSnapshot);
    expect(isSnapshotDirty(baseSnapshot, baseline)).toBe(false);
  });

  it("30. dirty when name changes", () => {
    const baseline = makeSnapshot(baseSnapshot);
    expect(isSnapshotDirty({ ...baseSnapshot, name: "Changed" }, baseline)).toBe(true);
  });
});
