/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DOC-089 — ExpenseService.approveExpense must delegate the entire financial
 * operation to review_approve_expense_v2.
 *
 * These are executable behavioural tests against a mocked Supabase client: they
 * prove which calls the service makes. The database-side guarantees (row
 * locking, real concurrency) are covered by contract assertions in
 * atomicApprovalDeduction.test.ts and must be proven at runtime during rollout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ExpenseService } from "@/services/ExpenseService";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/services/NotificationService", () => ({
  notifyExpenseApproved: vi.fn(),
  notifyEngineerExpenseApproved: vi.fn(),
  notifyExpenseVerified: vi.fn(),
  notifyExpenseSubmitted: vi.fn(),
  notifyExpenseSubmissionProgress: vi.fn(),
  notifyExpenseRejected: vi.fn(),
}));

const EXPENSE_ID = "exp-1";
const APPROVER = "eng-1";
const EMPLOYEE = "emp-1";
const ORG = "org-1";

/** Rows returned by `.limit()` / `.maybeSingle()`, in call order. */
let queue: any[] = [];

function nextResult() {
  return queue.length > 0 ? queue.shift() : { data: [], error: null };
}

/** Records every table touched and whether it was an update. */
const touched: { table: string; op: string; payload?: any }[] = [];

function makeBuilder(table: string) {
  const b: any = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain,
    eq: chain,
    in: chain,
    order: chain,
    insert: (payload: any) => {
      touched.push({ table, op: "insert", payload });
      return Promise.resolve({ data: null, error: null });
    },
    update: (payload: any) => {
      touched.push({ table, op: "update", payload });
      return b;
    },
    limit: () => Promise.resolve(nextResult()),
    maybeSingle: () => Promise.resolve(nextResult()),
    single: () => Promise.resolve(nextResult()),
    then: (res: any) => res(nextResult()),
  });
  return b;
}

function v2Response(before: number, deducted: number, expenseOver: any = {}) {
  return {
    ok: true,
    expense_id: EXPENSE_ID,
    expense: {
      id: EXPENSE_ID,
      user_id: EMPLOYEE,
      organization_id: ORG,
      title: "Trip",
      total_amount: deducted,
      status: "approved",
      ...expenseOver,
    },
    comment: null,
    auto_verified: false,
    balance: { before, deducted, after: before - deducted },
    deduction: { record_id: "ded-1", source: "approval" },
  };
}

/**
 * Seed the reads approveExpense performs before the RPC:
 * org id, 4 role checks, expense row, hierarchy flags.
 */
function seedApprovalReads(opts: { isAdmin?: boolean; status?: string; amount?: number } = {}) {
  const { isAdmin = false, status = "submitted", amount = 1200 } = opts;
  queue = [
    { data: { organization_id: ORG }, error: null },              // getUserOrganizationId
    { data: [{ role: isAdmin ? "admin" : "engineer" }], error: null }, // hasOrgRole admin
    { data: [{ role: isAdmin ? "admin" : "engineer" }], error: null }, // hasOrgRole engineer
    { data: [], error: null },                                     // team_leader
    { data: [], error: null },                                     // executive
    {
      data: {
        id: EXPENSE_ID, user_id: EMPLOYEE, total_amount: amount,
        title: "Trip", status, approval_tier: null,
        assigned_reviewer_id: APPROVER, assigned_engineer_id: APPROVER,
      },
      error: null,
    },
    { data: [], error: null },                                     // hierarchy flags
    { data: [{ engineer_approval_limit: 0 }], error: null },       // approval limit
    { data: [{ name: "Approver" }], error: null },                 // approver profile
    { data: [], error: null },                                     // owner-is-engineer
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  touched.length = 0;
  queue = [];
  vi.mocked(supabase.from).mockImplementation(((t: string) => makeBuilder(t)) as any);
});

describe("approveExpense calls V2 and nothing else financial", () => {
  it("calls review_approve_expense_v2, not V1", async () => {
    seedApprovalReads();
    vi.mocked(supabase.rpc).mockResolvedValue({ data: v2Response(5000, 1200), error: null } as any);

    await ExpenseService.approveExpense(EXPENSE_ID, APPROVER);

    const names = vi.mocked(supabase.rpc).mock.calls.map((c) => c[0]);
    expect(names).toContain("review_approve_expense_v2");
    expect(names).not.toContain("review_approve_expense");
  });

  it("passes only the expense id and comment — no balance, amount or user id", async () => {
    seedApprovalReads();
    vi.mocked(supabase.rpc).mockResolvedValue({ data: v2Response(5000, 1200), error: null } as any);

    await ExpenseService.approveExpense(EXPENSE_ID, APPROVER, "ok");

    const call = vi.mocked(supabase.rpc).mock.calls.find((c) => c[0] === "review_approve_expense_v2");
    expect(call?.[1]).toEqual({ p_expense_id: EXPENSE_ID, p_comment: "ok" });
  });

  it("never updates profiles from the client", async () => {
    seedApprovalReads();
    vi.mocked(supabase.rpc).mockResolvedValue({ data: v2Response(5000, 1200), error: null } as any);

    await ExpenseService.approveExpense(EXPENSE_ID, APPROVER);

    expect(touched.filter((t) => t.table === "profiles" && t.op === "update")).toEqual([]);
  });

  it("never writes an audit log from the client", async () => {
    // The financial audit is written inside the V2 transaction now.
    seedApprovalReads();
    vi.mocked(supabase.rpc).mockResolvedValue({ data: v2Response(5000, 1200), error: null } as any);

    await ExpenseService.approveExpense(EXPENSE_ID, APPROVER);

    expect(touched.filter((t) => t.table === "audit_logs")).toEqual([]);
  });

  it("never reverts the expense status after approval", async () => {
    seedApprovalReads();
    vi.mocked(supabase.rpc).mockResolvedValue({ data: v2Response(5000, 1200), error: null } as any);

    await ExpenseService.approveExpense(EXPENSE_ID, APPROVER);

    expect(touched.filter((t) => t.table === "expenses" && t.op === "update")).toEqual([]);
  });
});

describe("engineer approval — the incident scenario (§38)", () => {
  it("approves 1,200 against a 5,000 balance and reports 3,800 from the server", async () => {
    seedApprovalReads({ amount: 1200 });
    const rpc = v2Response(5000, 1200);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: rpc, error: null } as any);

    const result = await ExpenseService.approveExpense(EXPENSE_ID, APPROVER);

    expect(result.status).toBe("approved");
    expect(rpc.balance).toEqual({ before: 5000, deducted: 1200, after: 3800 });
    // The engineer's browser made no profile write — the whole point of the fix.
    expect(touched.filter((t) => t.table === "profiles" && t.op === "update")).toEqual([]);
  });
});

describe("negative balance is allowed (§43)", () => {
  it("succeeds when 1,000 is approved against 500", async () => {
    seedApprovalReads({ amount: 1000 });
    const rpc = v2Response(500, 1000);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: rpc, error: null } as any);

    const result = await ExpenseService.approveExpense(EXPENSE_ID, APPROVER);

    expect(result.status).toBe("approved");
    expect(rpc.balance.after).toBe(-500);
  });
});

describe("server failures propagate without client compensation (§40-§42)", () => {
  it.each([
    ["duplicate approval", "This expense is already approved"],
    ["missing profile", "No profile found for this employee in this organization; approval aborted"],
    ["ambiguous profile", "Ambiguous employee profile (2 rows) for this organization; approval aborted"],
  ])("%s: rejects and writes nothing locally", async (_label, message) => {
    seedApprovalReads();
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { message } } as any);

    await expect(ExpenseService.approveExpense(EXPENSE_ID, APPROVER)).rejects.toThrow();

    expect(touched.filter((t) => t.table === "profiles")).toEqual([]);
    expect(touched.filter((t) => t.table === "audit_logs")).toEqual([]);
    expect(touched.filter((t) => t.table === "expenses" && t.op === "update")).toEqual([]);
  });

  it("rejects a malformed balance block rather than showing a wrong number", async () => {
    seedApprovalReads();
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { ok: true, expense_id: EXPENSE_ID, expense: { status: "approved" } },
      error: null,
    } as any);

    await expect(ExpenseService.approveExpense(EXPENSE_ID, APPROVER)).rejects.toThrow(
      /no balance result/i,
    );
  });
});

describe("admin auto-approval uses the same path (§27, §44)", () => {
  it("submitExpense routes an admin's own expense through approveExpense", () => {
    const src = readFileSync(resolve(process.cwd(), "src/services/ExpenseService.ts"), "utf-8");
    expect(src).toContain('return await this.approveExpense(expenseId, userId, "Auto-approved: Admin expense")');
  });

  it("does not duplicate the audit that V2 now writes", async () => {
    seedApprovalReads({ isAdmin: true });
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { ...v2Response(5000, 1000), auto_verified: true },
      error: null,
    } as any);

    await ExpenseService.approveExpense(EXPENSE_ID, APPROVER);

    // expense_verified is inserted inside the V2 transaction, not here.
    expect(touched.filter((t) => t.table === "audit_logs")).toEqual([]);
  });
});

describe("source guards (§37, §45)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/services/ExpenseService.ts"), "utf-8");
  const approveFn = src.slice(
    src.indexOf("static async approveExpense("),
    src.indexOf("static async rejectExpense("),
  );

  it("approveExpense contains no profiles balance write", () => {
    expect(approveFn).not.toMatch(/from\(['"]profiles['"]\)[\s\S]{0,200}update\(/);
    expect(approveFn).not.toMatch(/update\(\{\s*balance/);
  });

  it("approveExpense computes no balance arithmetic", () => {
    expect(approveFn).not.toMatch(/currentBalance\s*-\s*expenseAmount/);
    expect(approveFn).not.toMatch(/newBalance/);
  });

  it("approveExpense builds no client-side deduction audit text", () => {
    expect(approveFn).not.toMatch(/Balance deducted/);
    expect(approveFn).not.toMatch(/Remaining balance/);
    expect(approveFn).not.toMatch(/Negative balance/);
  });

  it("approveExpense performs no status rollback", () => {
    expect(approveFn).not.toMatch(/previousStatusForRollback/);
    expect(approveFn).not.toMatch(/approval reverted/i);
  });

  it("batch review still delegates each approval to approveExpense", () => {
    const batch = src
      .slice(
        src.indexOf("static async processBatchReview("),
        src.indexOf("static async submitExpense("),
      )
      // The slice runs up to the next method, so it trails the following
      // function's JSDoc. Only executable code matters here.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(batch).toMatch(/this\.approveExpense\(expenseId, userId, comment\)/);
    // No browser-side batch balance arithmetic.
    expect(batch).not.toMatch(/balance/i);
  });
});
