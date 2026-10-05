/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MoneyReturnService -- "Return Money" feature correctness.
 *
 * These are executable behavioural tests against a mocked Supabase client.
 * Two concerns are covered:
 *
 * 1. Organization resolution (createReturnRequest): a requester with more
 *    than one active organization_memberships row must resolve against their
 *    CURRENT organization (profiles.organization_id), not an arbitrary row --
 *    see src/lib/currentMembership.ts and the getOrganizationIdForUser fix.
 *
 * 2. The atomic approve contract (approveReturnRequest): the client must
 *    delegate entirely to approve_money_return_request_v2 and do no balance
 *    arithmetic itself. The RPC's actual balance/ledger/history/FIFO-consume
 *    body lives in
 *    supabase/migrations/20260820130000_money_return_approve_v2.sql and
 *    cannot be executed by vitest against a real Postgres; `fakeApproveRpc`
 *    below is a deliberate line-for-line mirror of that function's
 *    documented contract (locking semantics aside), used to prove
 *    MoneyReturnService handles every one of its documented outcomes
 *    (success, already-processed retry, insufficient balance) correctly.
 *    Real concurrent-locking behavior must still be verified against the
 *    live RPC.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MoneyReturnService } from "@/services/MoneyReturnService";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/services/NotificationService", () => ({
  createNotification: vi.fn(),
}));

import { createNotification } from "@/services/NotificationService";

/** Rows returned by `.single()` / `.maybeSingle()` / direct-await, FIFO. */
let queue: any[] = [];
function nextResult() {
  return queue.length > 0 ? queue.shift() : { data: null, error: null };
}

/** Every `.eq()` call made against each mock builder, in order, for assertions. */
const eqCalls: { table: string; col: string; val: any }[] = [];
const touched: { table: string; op: string; payload?: any }[] = [];

function makeBuilder(table: string) {
  const b: any = {};
  Object.assign(b, {
    select: () => b,
    eq: (col: string, val: any) => {
      eqCalls.push({ table, col, val });
      return b;
    },
    in: () => b,
    order: () => b,
    insert: (payload: any) => {
      touched.push({ table, op: "insert", payload });
      return b;
    },
    update: (payload: any) => {
      touched.push({ table, op: "update", payload });
      return b;
    },
    maybeSingle: () => Promise.resolve(nextResult()),
    single: () => Promise.resolve(nextResult()),
    then: (resolve: any) => resolve(nextResult()),
  });
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  queue = [];
  eqCalls.length = 0;
  touched.length = 0;
  vi.mocked(supabase.from).mockImplementation(((t: string) => makeBuilder(t)) as any);
});

const REQUESTER = "requester-1";
const CASHIER = "cashier-1";
const ORG_A = "org-a";
const ORG_B = "org-b";

describe("createReturnRequest -- organization resolution", () => {
  it("prefers the requester's profile organization_id over an arbitrary active-membership row", async () => {
    // Requester holds TWO active memberships (org-a, org-b); their profile's
    // current org is org-b and the cashier only belongs to org-b. Before the
    // fix, `.limit(1).maybeSingle()` had no ORDER BY and could resolve org-a,
    // which would make the (correct, active) cashier look like they belong
    // to the wrong organization.
    queue = [
      { data: { balance: 50000, name: "Employee", organization_id: ORG_B }, error: null }, // profiles select
      { data: [{ organization_id: ORG_A }, { organization_id: ORG_B }], error: null },      // active memberships (both)
      { data: { user_id: CASHIER }, error: null },                                          // cashier membership check
      { data: { id: "req-1", requester_id: REQUESTER, cashier_id: CASHIER, amount: 20000, status: "pending" }, error: null }, // insert
    ];

    const result = await MoneyReturnService.createReturnRequest(REQUESTER, CASHIER, 20000, "note");

    expect(result.id).toBe("req-1");
    // The cashier-membership lookup must have been scoped to org-b, not org-a.
    const orgEq = eqCalls.filter((c) => c.table === "organization_memberships" && c.col === "organization_id");
    expect(orgEq.map((c) => c.val)).toContain(ORG_B);
    expect(orgEq.map((c) => c.val)).not.toContain(ORG_A);
  });

  it("falls back to the first active membership when the profile has no current organization", async () => {
    queue = [
      { data: { balance: 50000, name: "Employee", organization_id: null }, error: null },
      { data: [{ organization_id: ORG_A }], error: null },
      { data: { user_id: CASHIER }, error: null },
      { data: { id: "req-2" }, error: null },
    ];

    await MoneyReturnService.createReturnRequest(REQUESTER, CASHIER, 1000);

    const orgEq = eqCalls.filter((c) => c.table === "organization_memberships" && c.col === "organization_id");
    expect(orgEq.map((c) => c.val)).toContain(ORG_A);
  });

  it("rejects up front when the requester's balance is insufficient (no DB writes)", async () => {
    queue = [{ data: { balance: 5000, name: "Employee", organization_id: ORG_A }, error: null }];

    await expect(
      MoneyReturnService.createReturnRequest(REQUESTER, CASHIER, 20000),
    ).rejects.toThrow(/Insufficient balance/);

    expect(touched.filter((t) => t.table === "money_return_requests" && t.op === "insert")).toEqual([]);
  });

  it("throws when the assigned cashier is not an active cashier/admin in the requester's organization", async () => {
    queue = [
      { data: { balance: 50000, name: "Employee", organization_id: ORG_A }, error: null },
      { data: [{ organization_id: ORG_A }], error: null },
      { data: null, error: null }, // cashier membership check finds nothing
    ];

    await expect(
      MoneyReturnService.createReturnRequest(REQUESTER, CASHIER, 1000),
    ).rejects.toThrow(/not active in your organization/);
  });
});

describe("rejectReturnRequest -- balances must never move", () => {
  it("only updates money_return_requests; never touches profiles", async () => {
    queue = [
      {
        data: { id: "req-1", requester_id: REQUESTER, cashier_id: CASHIER, amount: 20000, status: "pending" },
        error: null,
      }, // fetch pending request
      { error: null }, // update -> rejected
      { data: { name: "Cashier" }, error: null }, // cashier profile for notification
    ];

    await MoneyReturnService.rejectReturnRequest("req-1", CASHIER, "not now");

    expect(touched.filter((t) => t.table === "profiles")).toEqual([]);
    expect(touched.filter((t) => t.table === "money_return_requests" && t.op === "update")).toEqual([
      expect.objectContaining({ table: "money_return_requests", op: "update" }),
    ]);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});

/**
 * A deliberate JS mirror of approve_money_return_request_v2's documented
 * contract (supabase/migrations/20260820130000_money_return_approve_v2.sql,
 * lines ~94-221): insufficient balance -> reject with zero mutation; success
 * -> debit requester / credit cashier, one balance_ledger row each side, one
 * cash_transfer_history row, status -> approved; already-processed ->
 * exception, zero mutation.
 */
function makeFakeApproveRpc(store: {
  profiles: Map<string, { balance: number }>;
  requests: Map<string, { requester_id: string; cashier_id: string; amount: number; status: string }>;
  ledger: any[];
  history: any[];
}, callerUid: string) {
  return vi.fn(async (fnName: string, args: any) => {
    if (fnName !== "approve_money_return_request_v2") {
      return { data: null, error: { message: `unexpected rpc ${fnName}` } };
    }
    const req = store.requests.get(args.p_request_id);
    if (!req) return { data: null, error: { message: "Return request not found" } };
    if (req.status !== "pending") {
      return { data: null, error: { message: "Return request is no longer pending" } };
    }
    if (req.cashier_id !== callerUid) {
      return { data: null, error: { message: "Only the assigned cashier can approve this request" } };
    }

    const requester = store.profiles.get(req.requester_id)!;
    const cashier = store.profiles.get(req.cashier_id)!;
    const requesterBefore = requester.balance;

    if (requesterBefore < req.amount) {
      req.status = "rejected";
      return {
        data: { ok: true, rejected: true, reason: "insufficient_balance", request_id: args.p_request_id },
        error: null,
      };
    }

    const cashierBefore = cashier.balance;
    const requesterAfter = requesterBefore - req.amount;
    const cashierAfter = cashierBefore + req.amount;
    requester.balance = requesterAfter;
    cashier.balance = cashierAfter;

    store.ledger.push({
      user_id: req.requester_id, amount_delta: -req.amount,
      balance_before: requesterBefore, balance_after: requesterAfter,
      entry_type: "cash_transfer_out", source_type: "money_return",
    });
    store.ledger.push({
      user_id: req.cashier_id, amount_delta: req.amount,
      balance_before: cashierBefore, balance_after: cashierAfter,
      entry_type: "cash_transfer_in", source_type: "money_return",
    });
    store.history.push({
      transferrer_id: req.requester_id, recipient_id: req.cashier_id,
      amount: req.amount, transfer_type: "employee_to_cashier",
    });
    req.status = "approved";

    return {
      data: {
        ok: true, rejected: false, request_id: args.p_request_id, amount: req.amount,
        requester_balance_after: requesterAfter, cashier_balance_after: cashierAfter,
      },
      error: null,
    };
  });
}

describe("approveReturnRequest -- atomic contract (mirrors approve_money_return_request_v2)", () => {
  it("moves exactly the requested amount both ways and leaves the combined total unchanged", async () => {
    const store = {
      profiles: new Map([[REQUESTER, { balance: 50000 }], [CASHIER, { balance: 10000 }]]),
      requests: new Map([["req-1", { requester_id: REQUESTER, cashier_id: CASHIER, amount: 20000, status: "pending" }]]),
      ledger: [] as any[],
      history: [] as any[],
    };
    vi.mocked(supabase.rpc).mockImplementation(makeFakeApproveRpc(store, CASHIER) as any);
    queue = [
      { data: { requester_id: REQUESTER }, error: null }, // re-read request for notification
      { data: { name: "Cashier" }, error: null },          // cashier profile for notification
    ];

    await MoneyReturnService.approveReturnRequest("req-1", CASHIER);

    expect(store.profiles.get(REQUESTER)!.balance).toBe(30000);
    expect(store.profiles.get(CASHIER)!.balance).toBe(30000);
    expect(store.profiles.get(REQUESTER)!.balance + store.profiles.get(CASHIER)!.balance).toBe(60000);
    expect(store.requests.get("req-1")!.status).toBe("approved");
    expect(store.ledger).toHaveLength(2);
    expect(store.ledger.filter((l) => l.user_id === REQUESTER)).toHaveLength(1);
    expect(store.ledger.filter((l) => l.user_id === CASHIER)).toHaveLength(1);
    expect(store.history).toHaveLength(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it("does not move money twice on a retried/duplicate approve call", async () => {
    const store = {
      profiles: new Map([[REQUESTER, { balance: 50000 }], [CASHIER, { balance: 10000 }]]),
      requests: new Map([["req-1", { requester_id: REQUESTER, cashier_id: CASHIER, amount: 20000, status: "pending" }]]),
      ledger: [] as any[],
      history: [] as any[],
    };
    vi.mocked(supabase.rpc).mockImplementation(makeFakeApproveRpc(store, CASHIER) as any);
    queue = [
      { data: { requester_id: REQUESTER }, error: null },
      { data: { name: "Cashier" }, error: null },
    ];

    await MoneyReturnService.approveReturnRequest("req-1", CASHIER);
    expect(store.profiles.get(REQUESTER)!.balance).toBe(30000);
    expect(store.profiles.get(CASHIER)!.balance).toBe(30000);

    // Second approve attempt on the same (now-approved) request.
    await expect(MoneyReturnService.approveReturnRequest("req-1", CASHIER)).rejects.toThrow(
      /no longer pending/,
    );

    expect(store.profiles.get(REQUESTER)!.balance).toBe(30000);
    expect(store.profiles.get(CASHIER)!.balance).toBe(30000);
    expect(store.ledger).toHaveLength(2); // still only the first approval's two rows
    expect(store.history).toHaveLength(1);
  });

  it("rejects safely when the requester has insufficient balance: zero balance mutation, zero ledger rows", async () => {
    const store = {
      profiles: new Map([[REQUESTER, { balance: 5000 }], [CASHIER, { balance: 10000 }]]),
      requests: new Map([["req-1", { requester_id: REQUESTER, cashier_id: CASHIER, amount: 20000, status: "pending" }]]),
      ledger: [] as any[],
      history: [] as any[],
    };
    vi.mocked(supabase.rpc).mockImplementation(makeFakeApproveRpc(store, CASHIER) as any);

    await expect(MoneyReturnService.approveReturnRequest("req-1", CASHIER)).rejects.toThrow(
      /[Ii]nsufficient balance/,
    );

    expect(store.profiles.get(REQUESTER)!.balance).toBe(5000);
    expect(store.profiles.get(CASHIER)!.balance).toBe(10000);
    expect(store.requests.get("req-1")!.status).toBe("rejected");
    expect(store.ledger).toHaveLength(0);
    expect(store.history).toHaveLength(0);
    // No notification is sent on a server-side rejection -- the service
    // throws before reaching that step.
    expect(createNotification).not.toHaveBeenCalled();
  });
});
