/**
 * Unit tests for expenseFieldDisplayModel.ts — hierarchy / grouped display
 *
 * Tests:
 * 1.  buildExpenseFieldDisplayGroups — base fields emit standalone nodes
 * 2.  buildExpenseFieldDisplayGroups — template without branch children emits standalone
 * 3.  buildExpenseFieldDisplayGroups — template with branches emits group node
 * 4.  buildExpenseFieldDisplayGroups — group contains all branch children
 * 5.  buildExpenseFieldDisplayGroups — branch children sorted by displayOrder
 * 6.  buildExpenseFieldDisplayGroups — standalone nodes sorted by displayOrder
 * 7.  buildExpenseFieldDisplayGroups — group node displayOrder = template displayOrder
 * 8.  buildExpenseFieldDisplayGroups — mixed nodes sorted correctly across each other
 * 9.  buildExpenseFieldDisplayGroups — legacy orphan emits standalone
 * 10. buildExpenseFieldDisplayGroups — branches without parentTemplateId emit standalone
 */

import { describe, it, expect } from "vitest";
import type { ExpenseDisplayFieldWithHierarchy } from "@/lib/expenseFieldDisplayModel";
import { buildExpenseFieldDisplayGroups } from "@/lib/expenseFieldDisplayModel";
import { defaultVisibilityFlags } from "@/lib/expenseFieldDisplayModel";

function makeField(
  overrides: Partial<ExpenseDisplayFieldWithHierarchy> & {
    stableId: string;
    label: string;
    displayOrder: number;
    source: ExpenseDisplayFieldWithHierarchy["source"];
  },
): ExpenseDisplayFieldWithHierarchy {
  return {
    stableId: overrides.stableId,
    label: overrides.label,
    value: overrides.value ?? "val",
    fieldType: overrides.fieldType ?? "text",
    displayOrder: overrides.displayOrder,
    source: overrides.source,
    visibility: overrides.visibility ?? defaultVisibilityFlags(),
    templateId: overrides.templateId ?? null,
    branchId: overrides.branchId ?? null,
    parentTemplateId: overrides.parentTemplateId ?? null,
    parentBranchId: overrides.parentBranchId ?? null,
    fieldKey: overrides.fieldKey ?? null,
    depth: overrides.depth ?? 0,
    fieldPath: overrides.fieldPath ?? null,
    groupStableId: overrides.groupStableId ?? null,
  };
}

const baseCategory = makeField({ stableId: "base:category", label: "Category", displayOrder: 10, source: "base" });
const baseAmount = makeField({ stableId: "base:amount", label: "Amount", displayOrder: 60, source: "base" });

const templateField = makeField({
  stableId: "template:tmpl-001",
  label: "Project Unique ID",
  value: "202606M250",
  displayOrder: 70,
  source: "template",
  templateId: "tmpl-001",
});

const branchPid = makeField({
  stableId: "branch:br-001",
  label: "Project ID",
  value: "17451",
  displayOrder: 0,
  source: "branch",
  branchId: "br-001",
  parentTemplateId: "tmpl-001",
  depth: 0,
  fieldKey: "project_id",
});

const branchPname = makeField({
  stableId: "branch:br-002",
  label: "Project Name",
  value: "Polycab India",
  displayOrder: 1,
  source: "branch",
  branchId: "br-002",
  parentTemplateId: "tmpl-001",
  depth: 0,
  fieldKey: "project_name",
});

describe("buildExpenseFieldDisplayGroups", () => {
  it("1. base fields emit standalone nodes", () => {
    const nodes = buildExpenseFieldDisplayGroups([baseCategory]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("field");
    if (nodes[0].kind === "field") {
      expect(nodes[0].field.stableId).toBe("base:category");
    }
  });

  it("2. template without branch children emits standalone", () => {
    const nodes = buildExpenseFieldDisplayGroups([templateField]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("field");
  });

  it("3. template with branches emits group node", () => {
    const nodes = buildExpenseFieldDisplayGroups([templateField, branchPid, branchPname]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("group");
  });

  it("4. group contains all branch children", () => {
    const nodes = buildExpenseFieldDisplayGroups([templateField, branchPid, branchPname]);
    expect(nodes[0].kind).toBe("group");
    if (nodes[0].kind === "group") {
      expect(nodes[0].group.children).toHaveLength(2);
    }
  });

  it("5. branch children sorted by displayOrder", () => {
    const reversed = [
      { ...branchPname, displayOrder: 1 },
      { ...branchPid, displayOrder: 0 },
    ];
    const nodes = buildExpenseFieldDisplayGroups([templateField, ...reversed]);
    expect(nodes[0].kind).toBe("group");
    if (nodes[0].kind === "group") {
      expect(nodes[0].group.children[0].fieldKey).toBe("project_id");
      expect(nodes[0].group.children[1].fieldKey).toBe("project_name");
    }
  });

  it("6. standalone nodes sorted by displayOrder", () => {
    const nodes = buildExpenseFieldDisplayGroups([baseAmount, baseCategory]);
    expect(nodes[0].kind).toBe("field");
    expect(nodes[1].kind).toBe("field");
    if (nodes[0].kind === "field" && nodes[1].kind === "field") {
      expect(nodes[0].field.displayOrder).toBeLessThan(nodes[1].field.displayOrder);
    }
  });

  it("7. group node displayOrder equals template field displayOrder", () => {
    const nodes = buildExpenseFieldDisplayGroups([templateField, branchPid]);
    expect(nodes[0].kind).toBe("group");
    if (nodes[0].kind === "group") {
      expect(nodes[0].group.displayOrder).toBe(70);
    }
  });

  it("8. mixed nodes sorted correctly across each other", () => {
    // baseCategory=10, templateField(group)=70, baseAmount=60
    // expected order: category(10) < amount(60) < group(70)
    const nodes = buildExpenseFieldDisplayGroups([baseAmount, templateField, branchPid, baseCategory]);
    const orders = nodes.map((n) =>
      n.kind === "field" ? n.field.displayOrder : n.group.displayOrder,
    );
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("9. legacy orphan emits standalone node", () => {
    const legacy = makeField({ stableId: "legacy:val-999", label: "Old Field", displayOrder: 9999, source: "legacy" });
    const nodes = buildExpenseFieldDisplayGroups([legacy]);
    expect(nodes[0].kind).toBe("field");
  });

  it("10. branch without parentTemplateId emits standalone", () => {
    const orphanBranch = makeField({
      stableId: "branch:orphan",
      label: "Orphan",
      displayOrder: 50,
      source: "branch",
      parentTemplateId: null, // no parent template link
    });
    const nodes = buildExpenseFieldDisplayGroups([orphanBranch]);
    expect(nodes[0].kind).toBe("field");
  });
});
