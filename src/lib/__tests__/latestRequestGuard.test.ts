import { describe, expect, it } from "vitest";
import {
  applyExpenseScopeChange,
  createLatestRequestGuard,
  responseStillCurrent,
} from "@/lib/latestRequestGuard";

describe("latest request guard", () => {
  it("lets only the newest ticket write", () => {
    const guard = createLatestRequestGuard();
    const older = guard.begin();
    const newer = guard.begin();
    expect(older.isCurrent()).toBe(false);
    expect(newer.isCurrent()).toBe(true);
  });

  it("invalidate() retires every ticket already issued", () => {
    const guard = createLatestRequestGuard();
    const ticket = guard.begin();
    guard.invalidate();
    expect(ticket.isCurrent()).toBe(false);
    expect(guard.begin().isCurrent()).toBe(true);
  });
});

describe("responseStillCurrent", () => {
  it("rejects a late response after the selected expense changed", () => {
    const guard = createLatestRequestGuard();
    const expenseA = "expense-a";
    const expenseB = "expense-b";
    let active: string | null = expenseA;
    const ticketA = guard.begin();
    active = expenseB;
    guard.invalidate();
    const ticketB = guard.begin();
    expect(responseStillCurrent(ticketA, expenseA, active)).toBe(false);
    expect(responseStillCurrent(ticketB, expenseB, active)).toBe(true);
  });

  it("rejects a response that arrives after the review is closed", () => {
    const guard = createLatestRequestGuard();
    const ticket = guard.begin();
    let active: string | null = "expense-a";
    guard.invalidate();
    active = null;
    expect(responseStillCurrent(ticket, "expense-a", active)).toBe(false);
  });

  it("rejects a current ticket whose payload belongs to a different expense", () => {
    const guard = createLatestRequestGuard();
    const ticket = guard.begin();
    expect(responseStillCurrent(ticket, "expense-a", "expense-b")).toBe(false);
  });
});

describe("applyExpenseScopeChange", () => {
  it("invalidates outstanding work only when the expense id changes", () => {
    let calls = 0;
    const same = applyExpenseScopeChange("expense-a", "expense-a", () => {
      calls += 1;
    });
    expect(same.changed).toBe(false);
    expect(calls).toBe(0);

    const next = applyExpenseScopeChange("expense-a", "expense-b", () => {
      calls += 1;
    });
    expect(next).toEqual({ scopeId: "expense-b", changed: true });
    expect(calls).toBe(1);
  });

  it("clears scope when the review closes", () => {
    let calls = 0;
    const closed = applyExpenseScopeChange("expense-a", null, () => {
      calls += 1;
    });
    expect(closed).toEqual({ scopeId: null, changed: true });
    expect(calls).toBe(1);
  });
});
