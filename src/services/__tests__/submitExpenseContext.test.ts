/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PWA performance hotfix: ExpenseService.submitExpense may be given a pre-loaded "submitter context" (org threshold,
 * roles, reporting chain, hierarchy inputs) that the form loads concurrently with preflight/resolve/finalize.
 *
 * Contract: identical decisions and an identical UPDATE payload (routing unchanged), with far fewer SEQUENTIAL round
 * trips; a missing / stale / foreign context is ignored and the original path runs; the bill requirement is unchanged.
 */
const LAT = 15; // ms per simulated network round trip
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const H = vi.hoisted(() => ({
  expense: { id: "e1", user_id: "u1", organization_id: "org1", total_amount: 100, status: "draft", title: "Trip" } as any,
  liveBills: [{ id: "a1" }] as any[],
  threshold: 499 as number | null,
  updates: [] as any[],
  log: [] as string[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    let op = "select";
    let payload: any = null;
    const b: any = {
      select: () => b,
      eq: () => b,
      is: () => b,
      in: () => b,
      order: () => b,
      update: (p: any) => {
        op = "update";
        payload = p;
        return b;
      },
      limit: async () => {
        await sleep(LAT);
        H.log.push(`${table}.limit`);
        if (table === "attachments") return { data: H.liveBills, error: null };
        if (table === "organization_settings")
          return { data: H.threshold === null ? [] : [{ attachment_required_above_amount: H.threshold }], error: null };
        if (table === "profiles") return { data: [{ reporting_engineer_id: "sup1", name: "Emp" }], error: null };
        return { data: [], error: null };
      },
      maybeSingle: async () => {
        await sleep(LAT);
        H.log.push(`${table}.${op}`);
        if (table === "expenses" && op === "update") {
          H.updates.push(payload);
          return { data: { ...H.expense, ...payload }, error: null };
        }
        if (table === "expenses") return { data: H.expense, error: null };
        return { data: null, error: null };
      },
    };
    return b;
  };
  return { supabase: { from: (t: string) => builder(t), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } };
});

import { ExpenseService } from "@/services/ExpenseService";

const HIER = { flags: { approval_hierarchy: false }, team: null, fallbackAdminUserId: null };
let helperCalls: Record<string, number>;

beforeEach(() => {
  H.expense = { id: "e1", user_id: "u1", organization_id: "org1", total_amount: 100, status: "draft", title: "Trip" };
  H.liveBills = [{ id: "a1" }];
  H.threshold = 499;
  H.updates = [];
  H.log = [];
  helperCalls = { hasOrgRole: 0, fetchMembershipRole: 0, loadHierarchyContext: 0 };
  const S = ExpenseService as any;
  vi.spyOn(S, "hasOrgRole").mockImplementation(async () => {
    helperCalls.hasOrgRole++;
    await sleep(LAT);
    return false;
  });
  vi.spyOn(S, "fetchMembershipRole").mockImplementation(async () => {
    helperCalls.fetchMembershipRole++;
    await sleep(LAT);
    return "employee";
  });
  vi.spyOn(S, "loadHierarchyContext").mockImplementation(async () => {
    helperCalls.loadHierarchyContext++;
    await sleep(LAT);
    return HIER;
  });
  vi.spyOn(S, "logAction").mockResolvedValue(undefined);
});

async function timed<T>(fn: () => Promise<T>) {
  const t0 = performance.now();
  const r = await fn();
  return { r, ms: performance.now() - t0 };
}

describe("submitExpense with a pre-loaded submitter context", () => {
  it("makes the same routing decision and sends the identical UPDATE payload", async () => {
    await ExpenseService.submitExpense("e1", "u1");
    const baseline = H.updates.pop();
    H.log = [];

    const ctx = await ExpenseService.loadSubmitContext("org1", "u1");
    await ExpenseService.submitExpense("e1", "u1", { context: ctx });
    const withCtx = H.updates.pop();

    const strip = (p: any) => ({ ...p, updated_at: "x" });
    expect(strip(withCtx)).toEqual(strip(baseline));
    expect(withCtx.status).toBe("submitted");
    expect(withCtx.assigned_engineer_id).toBe("sup1");
  });

  it("does ZERO role / profile / hierarchy lookups inside Submit when the context was loaded earlier", async () => {
    const ctx = await ExpenseService.loadSubmitContext("org1", "u1");
    helperCalls = { hasOrgRole: 0, fetchMembershipRole: 0, loadHierarchyContext: 0 };
    H.log = [];
    await ExpenseService.submitExpense("e1", "u1", { context: ctx });
    expect(helperCalls).toEqual({ hasOrgRole: 0, fetchMembershipRole: 0, loadHierarchyContext: 0 });
    expect(H.log).not.toContain("organization_settings.limit");
    expect(H.log).not.toContain("profiles.limit");
  });

  it("is much faster on the critical path: 2 sequential round trips instead of 5+", async () => {
    const without = await timed(() => ExpenseService.submitExpense("e1", "u1"));
    const ctx = await ExpenseService.loadSubmitContext("org1", "u1");
    const withCtx = await timed(() => ExpenseService.submitExpense("e1", "u1", { context: ctx }));
    expect(without.ms).toBeGreaterThanOrEqual(LAT * 4);
    expect(withCtx.ms).toBeLessThan(without.ms * 0.65);
  });

  it("a context for ANOTHER user is ignored (original path runs)", async () => {
    const ctx = await ExpenseService.loadSubmitContext("org1", "someone-else");
    helperCalls = { hasOrgRole: 0, fetchMembershipRole: 0, loadHierarchyContext: 0 };
    await ExpenseService.submitExpense("e1", "u1", { context: ctx });
    expect(helperCalls.hasOrgRole).toBe(2);
  });

  it("a context for ANOTHER organization is ignored (the expense's own org decides)", async () => {
    const ctx = await ExpenseService.loadSubmitContext("other-org", "u1");
    helperCalls = { hasOrgRole: 0, fetchMembershipRole: 0, loadHierarchyContext: 0 };
    await ExpenseService.submitExpense("e1", "u1", { context: ctx });
    expect(helperCalls.hasOrgRole).toBe(2);
  });

  it("a STALE context (older than the TTL) is ignored", async () => {
    const ctx = await ExpenseService.loadSubmitContext("org1", "u1");
    ctx.loadedAt = Date.now() - 10 * 60_000;
    helperCalls = { hasOrgRole: 0, fetchMembershipRole: 0, loadHierarchyContext: 0 };
    await ExpenseService.submitExpense("e1", "u1", { context: ctx });
    expect(helperCalls.hasOrgRole).toBe(2);
  });

  it("a null context (the early load failed) simply falls back", async () => {
    await expect(ExpenseService.submitExpense("e1", "u1", { context: null })).resolves.toBeTruthy();
    expect(helperCalls.hasOrgRole).toBe(2);
  });
});

describe("bill requirement is unchanged with a context", () => {
  it("above the threshold with NO live bill: refused with the same message, nothing updated", async () => {
    H.expense.total_amount = 800;
    H.liveBills = [];
    const ctx = await ExpenseService.loadSubmitContext("org1", "u1");
    await expect(ExpenseService.submitExpense("e1", "u1", { context: ctx })).rejects.toThrow(/Bill photos are required for expenses above/);
    expect(H.updates).toHaveLength(0);
  });

  it("above the threshold WITH a live bill: submits", async () => {
    H.expense.total_amount = 800;
    H.liveBills = [{ id: "a1" }];
    const ctx = await ExpenseService.loadSubmitContext("org1", "u1");
    const row: any = await ExpenseService.submitExpense("e1", "u1", { context: ctx });
    expect(row.status).toBe("submitted");
  });

  it("exactly at the threshold needs no bill (strictly greater than)", async () => {
    H.expense.total_amount = 499;
    H.liveBills = [];
    const ctx = await ExpenseService.loadSubmitContext("org1", "u1");
    await expect(ExpenseService.submitExpense("e1", "u1", { context: ctx })).resolves.toBeTruthy();
  });

  it("same refusal without a context (parity)", async () => {
    H.expense.total_amount = 800;
    H.liveBills = [];
    await expect(ExpenseService.submitExpense("e1", "u1")).rejects.toThrow(/Bill photos are required for expenses above/);
  });
});
