import { describe, expect, it } from "vitest";
import {
  type SelectableRow,
  canProceedWithApproval,
  classifyForApproval,
  expandSelectionToExpenseIds,
  isRowSelectable,
  needsApprovalWarning,
  pageSelectableKeys,
  selectAllState,
  selectionKey,
  splitSelectedKeys,
} from "@/lib/reviewBulkSelection";

const r = (id: string, state: SelectableRow["state"], batch_id?: string): SelectableRow => ({
  id,
  state,
  batch_id: batch_id ?? null,
});

describe("selectionKey", () => {
  it("keys a singular row by expense id and a batch child by batch id", () => {
    expect(selectionKey({ id: "e1", batch_id: null })).toBe("expense:e1");
    expect(selectionKey({ id: "e2", batch_id: "b9" })).toBe("batch:b9");
  });
});

describe("isRowSelectable — terminal never selectable", () => {
  it("ready and waiting are selectable, completed is not", () => {
    expect(isRowSelectable(r("e1", "ready"))).toBe(true);
    expect(isRowSelectable(r("e2", "waiting"))).toBe(true);
    expect(isRowSelectable(r("e3", "completed"))).toBe(false);
  });
});

describe("pageSelectableKeys — batch dedupe", () => {
  it("collapses a batch's children to one key and drops terminal rows", () => {
    const rows = [
      r("c1", "ready", "b9"),
      r("c2", "waiting", "b9"),
      r("c3", "ready", "b9"),
      r("s1", "ready"),
      r("t1", "completed"),
    ];
    expect(pageSelectableKeys(rows)).toEqual(["batch:b9", "expense:s1"]);
  });
});

describe("selectAllState tri-state", () => {
  const rows = [r("c1", "ready", "b9"), r("c2", "waiting", "b9"), r("s1", "ready"), r("t1", "completed")];
  it("none when nothing selected", () => {
    expect(selectAllState(new Set(), rows)).toBe("none");
  });
  it("some when a subset of keys selected", () => {
    expect(selectAllState(new Set(["batch:b9"]), rows)).toBe("some");
  });
  it("all when every selectable key selected (batch counts once)", () => {
    expect(selectAllState(new Set(["batch:b9", "expense:s1"]), rows)).toBe("all");
  });
  it("none when page has no selectable rows", () => {
    expect(selectAllState(new Set(["x"]), [r("t1", "completed")])).toBe("none");
  });
});

describe("expandSelectionToExpenseIds", () => {
  it("expands a batch key to every non-terminal child, deduped, never terminal", () => {
    const all = [
      r("c1", "ready", "b9"),
      r("c2", "waiting", "b9"),
      r("c3", "completed", "b9"), // terminal child excluded
      r("s1", "ready"),
      r("s2", "ready"),
    ];
    const ids = expandSelectionToExpenseIds(new Set(["batch:b9", "expense:s1"]), all);
    expect(ids.sort()).toEqual(["c1", "c2", "s1"]);
  });

  it("returns nothing for an all-terminal selection", () => {
    const all = [r("t1", "completed"), r("t2", "completed", "b1")];
    expect(expandSelectionToExpenseIds(new Set(["expense:t1", "batch:b1"]), all)).toEqual([]);
  });
});

describe("classifyForApproval (§25 buckets)", () => {
  const rows = [
    { id: "ready1", isReadyNow: true, isTerminal: false, amount: 1000 },
    { id: "ready2", isReadyNow: true, isTerminal: false, amount: 5000 }, // == limit → ready
    { id: "over1", isReadyNow: true, isTerminal: false, amount: 5001 }, // > limit
    { id: "wait1", isReadyNow: false, isTerminal: false, amount: 100 },
    { id: "done1", isReadyNow: false, isTerminal: true, amount: 100 },
  ];
  const c = classifyForApproval(rows, 5000);
  it("splits ready / over-limit / waiting / terminal", () => {
    expect(c.readyNow.sort()).toEqual(["ready1", "ready2"]);
    expect(c.overLimit).toEqual(["over1"]);
    expect(c.waiting).toEqual(["wait1"]);
    expect(c.terminal).toEqual(["done1"]);
  });
  it("needsApprovalWarning true when anything is not immediately approvable", () => {
    expect(needsApprovalWarning(c)).toBe(true);
    expect(needsApprovalWarning(classifyForApproval([rows[0]], 5000))).toBe(false);
  });

  it("§9: a WAITING + over-limit row is reported as OVER LIMIT, not waiting (even override can't approve it)", () => {
    const mixed = classifyForApproval(
      [{ id: "wait_over", isReadyNow: false, isTerminal: false, amount: 9999 }],
      5000,
    );
    expect(mixed.overLimit).toEqual(["wait_over"]);
    expect(mixed.waiting).toEqual([]);
  });
});

describe("canProceedWithApproval — override gating", () => {
  const withWaiting = classifyForApproval(
    [
      { id: "r1", isReadyNow: true, isTerminal: false, amount: 100 },
      { id: "w1", isReadyNow: false, isTerminal: false, amount: 100 },
    ],
    5000,
  );
  const readyOnly = classifyForApproval([{ id: "r1", isReadyNow: true, isTerminal: false, amount: 100 }], 5000);
  const overOnly = classifyForApproval([{ id: "o1", isReadyNow: true, isTerminal: false, amount: 9999 }], 5000);

  it("blocks PROCEED when waiting rows are present and override is not installed", () => {
    expect(canProceedWithApproval(withWaiting, false)).toBe(false);
  });
  it("allows PROCEED for waiting rows only when override is available", () => {
    expect(canProceedWithApproval(withWaiting, true)).toBe(true);
  });
  it("allows PROCEED for a ready-only selection", () => {
    expect(canProceedWithApproval(readyOnly, false)).toBe(true);
  });
  it("blocks PROCEED when nothing is actually approvable (only over-limit)", () => {
    expect(canProceedWithApproval(overOnly, false)).toBe(false);
  });
});

describe("splitSelectedKeys — DOC-098 batch vs singular routing", () => {
  it("splits a mix of batch and expense keys into two id arrays", () => {
    const selected = new Set(["batch:b1", "expense:e1", "batch:b2", "expense:e2"]);
    expect(splitSelectedKeys(selected)).toEqual({
      batchIds: ["b1", "b2"],
      singularIds: ["e1", "e2"],
    });
  });

  it("returns empty arrays for an empty selection", () => {
    expect(splitSelectedKeys(new Set())).toEqual({ batchIds: [], singularIds: [] });
  });

  it("returns only batch ids when nothing singular is selected (TEST A/C fixture)", () => {
    const selected = new Set(["batch:efbb8ce0"]);
    expect(splitSelectedKeys(selected)).toEqual({ batchIds: ["efbb8ce0"], singularIds: [] });
  });

  it("keeps multiple batch ids independent (TEST D: A valid, B blocked, C valid)", () => {
    const selected = new Set(["batch:A", "batch:B", "batch:C"]);
    const { batchIds } = splitSelectedKeys(selected);
    expect(batchIds).toEqual(["A", "B", "C"]);
  });

  it("splits one singular and two batches without duplicate processing (TEST E)", () => {
    const selected = new Set(["expense:e1", "batch:b1", "batch:b2"]);
    expect(splitSelectedKeys(selected)).toEqual({
      batchIds: ["b1", "b2"],
      singularIds: ["e1"],
    });
  });
});
