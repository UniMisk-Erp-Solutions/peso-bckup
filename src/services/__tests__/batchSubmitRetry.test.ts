/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DOC-148 -- batch submit: partial failure, retry identity, link-error visibility, preflight.
 * Drives the REAL ExpenseService.submitExpenseBatch against an in-memory fake database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpenseService, SubmissionPreflightError } from "@/services/ExpenseService";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

type Row = { id: string; status: string; batch_id: string | null; title: string };
let rows: Map<string, Row>;
let batchInserts: number;
let seq: number;
let linkFails: Set<string>;

/** One generic chainable builder; resolves by table + what was selected. */
function builder(table: string) {
  let selected = "";
  let eqId: string | null = null;
  const b: any = {
    select: (cols?: string) => { selected = cols ?? ""; return b; },
    eq: (col: string, val: string) => { if (col === "id") eqId = val; return b; },
    is: () => b,
    limit: async () => ({ data: [], error: null }),
    insert: () => {
      if (table === "expense_batches") batchInserts += 1;
      return b;
    },
    update: () => b,
    single: async () => ({ data: { id: "batch-1" }, error: null }),
    maybeSingle: async () => {
      if (table === "organization_memberships") return { data: { organization_id: "org-1" }, error: null };
      if (table === "expenses" && eqId) {
        const r = rows.get(eqId);
        if (selected.includes("transaction_number")) return { data: { transaction_number: `T-${eqId}` }, error: null };
        return { data: r ? { status: r.status } : null, error: null };
      }
      return { data: null, error: null };
    },
    then: (res: any) => res({ data: null, error: null }),
  };
  return b;
}

const lines = Array.from({ length: 10 }, (_, i) => ({
  title: `Line ${i + 1}`, amount: 10 + i, category: "Travel", destination: "X",
}));
const basePayload = () => ({
  shared: { expenseDate: new Date("2026-10-10") },
  lines,
  attachmentMode: "per_line" as const,
  metaByFilename: {},
});

beforeEach(() => {
  rows = new Map();
  batchInserts = 0;
  seq = 0;
  linkFails = new Set();
  vi.restoreAllMocks();
  vi.mocked(supabase.from).mockImplementation(((t: string) => builder(t)) as any);
  vi.spyOn(ExpenseService, "isBatchExpenseEntryEnabled").mockResolvedValue(true);
  vi.spyOn(ExpenseService, "isOrganizationFeatureEnabled").mockResolvedValue(false);
  vi.spyOn(ExpenseService, "preflightExpenseSubmission").mockResolvedValue({ ok: true, verified: true, issues: [] });
  vi.spyOn(ExpenseService, "trackCategoryUsage" as any).mockResolvedValue(undefined);
  // SERVER model: (clientBatchId) -> one batch; (clientBatchId, lineIndex) -> one expense.
  const batches = new Map<string, string>();
  const lineRows = new Map<string, string>();
  vi.spyOn(ExpenseService, "resolveOrCreateBatch").mockImplementation((async (_org: string, cbid: string) => {
    batchInserts += batches.has(cbid) ? 0 : 1;
    if (!batches.has(cbid)) batches.set(cbid, `batch-${batches.size + 1}`);
    return { batchId: batches.get(cbid)!, created: false };
  }) as any);
  vi.spyOn(ExpenseService, "resolveOrCreateExpense").mockImplementation((async (_org: string, identity: any, fields: any) => {
    const key = `${identity.clientBatchId}:${identity.lineIndex}`;
    let created = false;
    if (!lineRows.has(key)) {
      const id = `exp-${++seq}`;
      rows.set(id, { id, status: "draft", batch_id: null, title: fields.title });
      lineRows.set(key, id);
      created = true;
    }
    const id = lineRows.get(key)!;
    const row = rows.get(id)!;
    if (row.status === "draft") {
      row.title = fields.title;
      if (linkFails.has(fields.title)) throw new Error("The expense could not be added to its batch.");
      row.batch_id = identity.batchId;
    }
    return { expenseId: id, status: row.status, created, idempotentReplay: !created, inRecycleBin: false, transactionNumber: null };
  }) as any);
});

function failSubmitForLine(titleToFail: string | null) {
  vi.spyOn(ExpenseService, "submitExpense").mockImplementation((async (id: string) => {
    if (titleToFail && rows.get(id)!.title === titleToFail) throw new Error("server said no");
    rows.get(id)!.status = "submitted";
    return {} as any;
  }) as any);
}

describe("batch submit: partial failure then retry (server-side identity)", () => {
  it("10-line batch, line 6 fails, retry with the SAME clientBatchId and NO resume object (a fresh page) => exactly 10 rows", async () => {
    const clientBatchId = "11111111-1111-4111-8111-111111111111";
    failSubmitForLine("Line 6");
    const first = await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), clientBatchId });
    expect(first.successCount).toBe(9);
    expect(first.failureCount).toBe(1);
    expect(first.results.find((r) => !r.ok)!.lineIndex).toBe(5);
    expect(rows.size).toBe(10);

    // "reload": nothing but the logical batch id survives; the retry succeeds this time
    failSubmitForLine(null);
    const second = await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), clientBatchId });
    expect(second.successCount).toBe(10);
    expect(rows.size).toBe(10); // NOT 11, 15 or 16
    expect([...rows.values()].every((r) => r.status === "submitted")).toBe(true);
    expect(batchInserts).toBe(1);
    expect(second.batchId).toBe(first.batchId);
    expect(ExpenseService.submitExpense).toHaveBeenCalledTimes(1); // only the failed line was submitted again
  });

  it("an exact duplicate batch request (double submit) creates no extra batch or rows", async () => {
    const clientBatchId = "22222222-2222-4222-8222-222222222222";
    failSubmitForLine(null);
    await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), clientBatchId });
    const again = await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), clientBatchId });
    expect(again.successCount).toBe(10);
    expect(rows.size).toBe(10);
    expect(batchInserts).toBe(1);
    expect(ExpenseService.submitExpense).toHaveBeenCalledTimes(10); // the replay re-submitted nothing
  });

  it("a different clientBatchId is a different logical batch", async () => {
    failSubmitForLine(null);
    await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), clientBatchId: "33333333-3333-4333-8333-333333333333" });
    await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), clientBatchId: "44444444-4444-4444-8444-444444444444" });
    expect(rows.size).toBe(20);
    expect(batchInserts).toBe(2);
  });

  it("every child is linked to the batch (the silent orphaning is gone)", async () => {
    failSubmitForLine(null);
    const res = await ExpenseService.submitExpenseBatch("user-1", basePayload());
    expect(res.successCount).toBe(10);
    expect([...rows.values()].every((r) => r.batch_id === res.batchId)).toBe(true);
  });
});

describe("batch link failure is visible and stops that line", () => {
  it("a failing link marks the line failed, never submits it, and the retry resolves to the same row", async () => {
    const clientBatchId = "55555555-5555-4555-8555-555555555555";
    failSubmitForLine(null);
    linkFails.add("Line 3");
    const res = await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), clientBatchId });
    const bad = res.results.find((r) => !r.ok)!;
    expect(bad.lineIndex).toBe(2);
    expect(bad.error).toMatch(/batch/i);
    expect(res.successCount).toBe(9);
    const draftsBefore = [...rows.values()].filter((r) => r.status === "draft");
    expect(draftsBefore).toHaveLength(1);

    linkFails.clear();
    const retry = await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), clientBatchId });
    expect(retry.successCount).toBe(10);
    expect(rows.size).toBe(10);
  });
});

describe("batch preflight: server refusal creates nothing", () => {
  it("throws SubmissionPreflightError before any batch row or draft child exists", async () => {
    vi.spyOn(ExpenseService, "preflightExpenseSubmission").mockResolvedValue({
      ok: false, verified: true,
      issues: [{ label: "Project Unique ID", source: "category_field", code: "MISSING_REQUIRED_VALUE", severity: "user_fixable" }],
    });
    await expect(ExpenseService.submitExpenseBatch("user-1", basePayload())).rejects.toBeInstanceOf(SubmissionPreflightError);
    expect(ExpenseService.resolveOrCreateExpense).not.toHaveBeenCalled();
    expect(batchInserts).toBe(0);
    expect(rows.size).toBe(0);
  });

  it("an unreachable preflight does not block (the server validator stays the final gate)", async () => {
    failSubmitForLine(null);
    vi.spyOn(ExpenseService, "preflightExpenseSubmission").mockResolvedValue({ ok: true, verified: false, issues: [] });
    const res = await ExpenseService.submitExpenseBatch("user-1", basePayload());
    expect(res.successCount).toBe(10);
  });
});

describe("batch with a bill threshold (DOC-150): each line is judged on its own amount", () => {
  it("300 passes, 800 with a bill passes, 1200 without a bill fails ALONE; retry after adding the bill reuses the same line", async () => {
    const clientBatchId = "66666666-6666-4666-8666-666666666666";
    const mixed = [
      { title: "Line 1", amount: 300, category: "Travel", destination: "X" },
      { title: "Line 2", amount: 800, category: "Travel", destination: "X" },
      { title: "Line 3", amount: 1200, category: "Travel", destination: "X" },
    ];
    const billed = new Set<string>(["Line 2"]);
    vi.spyOn(ExpenseService, "submitExpense").mockImplementation((async (id: string) => {
      const row = rows.get(id)!;
      const amount = mixed.find((m) => m.title === row.title)!.amount;
      if (amount > 499 && !billed.has(row.title)) {
        throw Object.assign(new Error("Bill photos are required for expenses above ₹499. Please upload at least one receipt or bill before submitting."), { code: "23514" });
      }
      row.status = "submitted";
      return {} as any;
    }) as any);

    const first = await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), lines: mixed, clientBatchId });
    expect(first.successCount).toBe(2);
    const bad = first.results.find((r) => !r.ok)!;
    expect(bad.lineIndex).toBe(2);
    expect(bad.error).toMatch(/Bill photos are required for expenses above ₹499/);
    expect(rows.size).toBe(3);
    expect(rows.get(bad.expenseId!)!.status).toBe("draft"); // preserved under its logical identity, not duplicated

    billed.add("Line 3"); // the employee adds the bill, presses Retry failed lines
    const retry = await ExpenseService.submitExpenseBatch("user-1", { ...basePayload(), lines: mixed, clientBatchId });
    expect(retry.successCount).toBe(3);
    expect(rows.size).toBe(3); // still exactly three logical rows
    expect(batchInserts).toBe(1);
    expect(ExpenseService.submitExpense).toHaveBeenCalledTimes(4); // 3 first time (one refused) + only the failed line again
  });
});
