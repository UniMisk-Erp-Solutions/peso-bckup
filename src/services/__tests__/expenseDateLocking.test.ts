/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DOC-138 — Admin-controlled expense date locking, application-layer tests.
 *
 * Covers the THREE things this feature's application code is responsible for
 * (the DB table/functions/trigger from
 * supabase/migrations/20261018100000_expense_date_locking_v1.sql are not yet
 * deployed to Production and are out of scope here):
 *
 *  1. `ExpenseService.createExpense()` — a server-authoritative preflight
 *     (`is_expense_date_locked_v1` via RPC) that blocks a brand-new expense
 *     BEFORE any row is written, only when the caller says the feature is on
 *     for this org (`options.dateLockingEnabled`); zero added RPC calls when
 *     omitted/false, matching the feature-OFF byte-for-byte-unchanged
 *     requirement.
 *  2. `ExpenseService.submitExpense()` — the admin-submitting-their-own-
 *     expense branch now actually checks the status-transition UPDATE's
 *     error/returned row before calling `approveExpense()` (previously
 *     unchecked entirely), and every branch (admin-self, engineer,
 *     hierarchy/employee) recognises the trigger's SQLSTATE PW010 rejection
 *     and throws a distinguishable `ExpenseDateLockedError` (draft preserved,
 *     expense id attached) instead of a generic error or a silent fall-
 *     through into approval.
 *  3. `ExpenseService.submitExpenseBatch()` — the same server-authoritative
 *     preflight, once per batch (all lines share one trip date), before the
 *     `expense_batches` row (or any child expense) is created.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExpenseService,
  ExpenseDateLockedError,
  isExpenseDateLockedError,
  type CreateExpenseData,
} from "@/services/ExpenseService";
import { supabase } from "@/integrations/supabase/client";
import { formatExpenseDateString } from "@/lib/expenseBatchValidation";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

/** Queue of `{data, error}` results consumed, in order, by whatever read resolves next. */
let queue: any[] = [];
function nextResult() {
  return queue.length > 0 ? queue.shift() : { data: null, error: null };
}

/** Records every insert this builder sees, so a test can assert "zero writes happened". */
const inserts: { table: string; payload: any }[] = [];
const updates: { table: string; payload: any }[] = [];

function makeBuilder(table: string) {
  const b: any = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain,
    eq: chain,
    in: chain,
    order: chain,
    not: chain,
    insert: (payload: any) => {
      inserts.push({ table, payload });
      return b;
    },
    update: (payload: any) => {
      updates.push({ table, payload });
      return b;
    },
    limit: () => Promise.resolve(nextResult()),
    maybeSingle: () => Promise.resolve(nextResult()),
    single: () => Promise.resolve(nextResult()),
  });
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  queue = [];
  inserts.length = 0;
  updates.length = 0;
  vi.mocked(supabase.from).mockImplementation(((t: string) => makeBuilder(t)) as any);
  vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isExpenseDateLockedError", () => {
  it("recognises an ExpenseDateLockedError and nothing else", () => {
    expect(isExpenseDateLockedError(new ExpenseDateLockedError())).toBe(true);
    expect(isExpenseDateLockedError(new Error("plain"))).toBe(false);
    expect(isExpenseDateLockedError({ code: "PW010" })).toBe(false);
  });

  it("carries expenseId and draftPreserved for the existing-draft race shape", () => {
    const err = new ExpenseDateLockedError({ expenseId: "exp-9", draftPreserved: true });
    expect(err.expenseId).toBe("exp-9");
    expect(err.draftPreserved).toBe(true);
    expect(err.code).toBe("PW010");
  });
});

describe("ExpenseService.createExpense — expense date lock preflight", () => {
  const expenseData: CreateExpenseData = {
    title: "Taxi",
    destination: "Mumbai",
    trip_start: "2026-08-05",
    trip_end: "2026-08-05",
    amount: 100,
    category: "travel",
  };

  it("blocks creation and performs ZERO writes when the server says this date is locked", async () => {
    queue = [{ data: { organization_id: "org-1" }, error: null }]; // getUserOrganizationId
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as any);

    await expect(
      ExpenseService.createExpense("user-1", expenseData, { dateLockingEnabled: true }),
    ).rejects.toSatisfy((e: unknown) => isExpenseDateLockedError(e) && e.draftPreserved === false);

    expect(supabase.rpc).toHaveBeenCalledWith("is_expense_date_locked_v1", {
      p_organization_id: "org-1",
      p_expense_date: "2026-08-05",
    });
    expect(inserts).toEqual([]); // no expense row, no attachments, no custom fields, no audit row
  });

  it("proceeds normally when dateLockingEnabled is true but the date is clear", async () => {
    const createdRow = { id: "exp-1", status: "draft", total_amount: 100 };
    queue = [
      { data: { organization_id: "org-1" }, error: null }, // getUserOrganizationId
      { data: createdRow, error: null }, // expense insert
    ];
    vi.mocked(supabase.rpc).mockResolvedValue({ data: false, error: null } as any);

    const result = await ExpenseService.createExpense("user-1", expenseData, {
      dateLockingEnabled: true,
    });

    expect(result.id).toBe("exp-1");
    expect(inserts.some((i) => i.table === "expenses")).toBe(true);
  });

  it("feature OFF: never calls the lock RPC at all, zero behavior change", async () => {
    const createdRow = { id: "exp-1", status: "draft", total_amount: 100 };
    queue = [
      { data: { organization_id: "org-1" }, error: null },
      { data: createdRow, error: null },
    ];

    const result = await ExpenseService.createExpense("user-1", expenseData); // no options at all

    expect(result.id).toBe("exp-1");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("dateLockingEnabled explicitly false also never calls the lock RPC", async () => {
    const createdRow = { id: "exp-1", status: "draft", total_amount: 100 };
    queue = [
      { data: { organization_id: "org-1" }, error: null },
      { data: createdRow, error: null },
    ];

    await ExpenseService.createExpense("user-1", expenseData, { dateLockingEnabled: false });

    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe("ExpenseService.submitExpense — admin submitting their OWN expense", () => {
  const mockDraftExpense = {
    id: "expense-1",
    user_id: "user-1",
    status: "draft",
    total_amount: 30, // below the default 50 attachment-required threshold
    organization_id: "org-1",
    title: "Test",
  };

  beforeEach(() => {
    // isAdmin=true, isEngineer=false — matches this describe block's scenario.
    vi.spyOn(ExpenseService as any, "hasOrgRole").mockImplementation(
      (async (_u: string, _o: string, role: string) => role === "admin") as any,
    );
  });

  it("blocked exactly like a normal user: PW010 throws ExpenseDateLockedError and never calls approveExpense (no admin bypass)", async () => {
    queue = [
      { data: mockDraftExpense, error: null }, // expense fetch
      { data: [], error: null }, // selectFirstOrgSettingsRow .limit(1) — attachment_required_above_amount
      {
        data: null,
        error: { code: "PW010", details: "EXPENSE_DATE_LOCKED", message: "This expense date is closed for submission." },
      }, // status-transition UPDATE, rejected by the trigger
    ];
    const approveSpy = vi.spyOn(ExpenseService, "approveExpense").mockResolvedValue({} as any);

    const rejection = await ExpenseService.submitExpense("expense-1", "user-1").catch((e) => e);
    expect(isExpenseDateLockedError(rejection)).toBe(true);
    expect(rejection.draftPreserved).toBe(true);
    expect(rejection.expenseId).toBe("expense-1");
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it("does NOT call approveExpense when the UPDATE returns no error but the row isn't actually submitted", async () => {
    queue = [
      { data: mockDraftExpense, error: null }, // expense fetch
      { data: [], error: null }, // selectFirstOrgSettingsRow .limit(1)
      { data: { id: "expense-1", status: "draft" }, error: null }, // UPDATE "succeeded" but status unchanged
      { data: { id: "expense-1", status: "draft" }, error: null }, // defensive refetch (same outcome)
    ];
    const approveSpy = vi.spyOn(ExpenseService, "approveExpense").mockResolvedValue({} as any);

    await expect(ExpenseService.submitExpense("expense-1", "user-1")).rejects.toThrow(/Submission failed/);
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it("calls approveExpense only after confirming the UPDATE actually landed at submitted", async () => {
    queue = [
      { data: mockDraftExpense, error: null }, // expense fetch
      { data: [], error: null }, // selectFirstOrgSettingsRow .limit(1)
      { data: { id: "expense-1", status: "submitted" }, error: null }, // UPDATE succeeded
    ];
    const approveSpy = vi
      .spyOn(ExpenseService, "approveExpense")
      .mockResolvedValue({ id: "expense-1", status: "approved" } as any);

    const result = await ExpenseService.submitExpense("expense-1", "user-1");

    expect(approveSpy).toHaveBeenCalledWith("expense-1", "user-1", "Auto-approved: Admin expense");
    expect(result).toEqual({ id: "expense-1", status: "approved" });
  });
});

describe("ExpenseService.submitExpense — existing-draft race on a normal (non-admin) submission", () => {
  const mockDraftExpense = {
    id: "expense-1",
    user_id: "user-1",
    status: "draft",
    total_amount: 30,
    organization_id: "org-1",
    title: "Test",
  };

  beforeEach(() => {
    // isAdmin=false, isEngineer=true — exercises the engineer branch's own UPDATE,
    // proving PW010 handling isn't specific to the admin-self-submit path (item 3:
    // "for any user, not just the admin-self-submit path").
    vi.spyOn(ExpenseService as any, "hasOrgRole").mockImplementation(
      (async (_u: string, _o: string, role: string) => role === "engineer") as any,
    );
  });

  it("leaves the expense as draft and throws the recognisable date-locked condition with the expense id attached", async () => {
    queue = [
      { data: mockDraftExpense, error: null }, // expense fetch
      { data: [], error: null }, // selectFirstOrgSettingsRow .limit(1)
      {
        data: null,
        error: { code: "PW010", details: "EXPENSE_DATE_LOCKED", message: "This expense date is closed for submission." },
      }, // status-transition UPDATE, rejected by the trigger
    ];

    const rejection = await ExpenseService.submitExpense("expense-1", "user-1").catch((e) => e);

    expect(isExpenseDateLockedError(rejection)).toBe(true);
    expect(rejection.draftPreserved).toBe(true);
    expect(rejection.expenseId).toBe("expense-1");
    // Not a generic Error, and not swallowed: distinguishable from any other failure mode.
    expect(rejection).not.toBe(undefined);
    expect(updates.some((u) => u.table === "expenses")).toBe(true); // the UPDATE was attempted
  });

  it("a clear date proceeds normally through the same branch (no false positives)", async () => {
    queue = [
      { data: mockDraftExpense, error: null }, // expense fetch
      { data: [], error: null }, // selectFirstOrgSettingsRow .limit(1)
      { data: { id: "expense-1", status: "submitted", title: "Test" }, error: null }, // UPDATE succeeds
    ];

    const result = await ExpenseService.submitExpense("expense-1", "user-1");
    expect(result.status).toBe("submitted");
  });
});

describe("ExpenseService.submitExpenseBatch — expense date lock preflight", () => {
  it("blocks the entire batch before creating the expense_batches row when the shared date is locked", async () => {
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === "organization_memberships") {
        return makeBuilderWithQueue([{ data: { organization_id: "org-1" }, error: null }]);
      }
      if (table === "organization_features") {
        // Both isBatchExpenseEntryEnabled and the date-locking feature check
        // read this table; both are "on" for this test.
        return makeBuilderWithQueue([
          { data: { enabled: true }, error: null },
          { data: { enabled: true }, error: null },
        ]);
      }
      return makeBuilder(table);
    }) as any);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as any); // unused by this RPC path

    // is_expense_date_locked_v1 is called via `supabase.rpc` in this module's
    // isExpenseDateLockedOnServer — stub it to report "locked".
    const rpcSpy = vi.spyOn(ExpenseService, "isExpenseDateLockedOnServer").mockResolvedValue(true);

    const sharedExpenseDate = new Date("2026-08-05");

    await expect(
      ExpenseService.submitExpenseBatch("user-1", {
        shared: { expenseDate: sharedExpenseDate, sharedDestination: "Mumbai" },
        lines: [{ title: "Taxi", amount: 100, category: "travel", destination: "Mumbai" }],
        attachmentMode: "per_line",
        metaByFilename: {},
      }),
    ).rejects.toSatisfy((e: unknown) => isExpenseDateLockedError(e));

    expect(rpcSpy).toHaveBeenCalledWith("org-1", formatExpenseDateString(sharedExpenseDate));
    expect(inserts.some((i) => i.table === "expense_batches")).toBe(false);
  });
});

/** Small helper: a builder whose select/eq/maybeSingle chain drains a fixed queue (per-table). */
function makeBuilderWithQueue(localQueue: any[]) {
  const b: any = {};
  const chain = () => b;
  let q = localQueue;
  Object.assign(b, {
    select: chain,
    eq: chain,
    in: chain,
    order: chain,
    not: chain,
    insert: (payload: any) => {
      inserts.push({ table: "organization_memberships", payload });
      return b;
    },
    update: chain,
    limit: () => Promise.resolve(q.length > 0 ? q.shift() : { data: [], error: null }),
    maybeSingle: () => Promise.resolve(q.length > 0 ? q.shift() : { data: null, error: null }),
    single: () => Promise.resolve(q.length > 0 ? q.shift() : { data: null, error: null }),
  });
  return b;
}
