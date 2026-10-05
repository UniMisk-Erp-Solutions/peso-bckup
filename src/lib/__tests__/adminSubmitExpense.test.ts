import { describe, expect, it, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock("@/lib/receiptFinalization", () => ({
  invokeFinalizeExpenseReceipts: vi.fn(),
  runWithConcurrency: async (tasks: Array<() => Promise<unknown>>) => {
    for (const task of tasks) await task();
    return [];
  },
}));

import {
  submitExpenseForEmployee,
  submitBulkExpensesForEmployees,
  finalizePendingReceiptsForExpense,
  AdminSubmitExpenseError,
  BULK_SUBMIT_CHUNK_SIZE,
} from "@/lib/adminSubmitExpense";
import { invokeFinalizeExpenseReceipts } from "@/lib/receiptFinalization";

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
  vi.mocked(invokeFinalizeExpenseReceipts).mockReset();
});

const validInput = {
  organizationId: "org-1",
  employeeId: "emp-1",
  title: "Client visit",
  destination: "Site A",
  tripStart: "2026-09-01",
  tripEnd: "2026-09-01",
  category: "Travel",
  amount: 500,
};

describe("submitExpenseForEmployee — success path", () => {
  it("passes every field through to the RPC with the correct parameter names", async () => {
    rpcMock.mockResolvedValue({
      data: {
        expense_id: "exp-1",
        status: "submitted",
        approval_tier: null,
        assigned_reviewer_id: null,
        assigned_engineer_id: null,
        custom_fields_saved: 0,
        idempotent_replay: false,
      },
      error: null,
    });

    const result = await submitExpenseForEmployee({ ...validInput, idempotencyKey: "key-1" });

    expect(rpcMock).toHaveBeenCalledWith(
      "admin_submit_expense_for_employee_v2",
      expect.objectContaining({
        p_organization_id: "org-1",
        p_employee_id: "emp-1",
        p_title: "Client visit",
        p_amount: 500,
        p_status: "submitted",
        p_idempotency_key: "key-1",
      }),
    );
    expect(result.expenseId).toBe("exp-1");
    expect(result.idempotentReplay).toBe(false);
  });

  it("defaults status to 'submitted' and idempotency key to null when omitted", async () => {
    rpcMock.mockResolvedValue({
      data: { expense_id: "exp-1", status: "submitted", custom_fields_saved: 0, idempotent_replay: false },
      error: null,
    });
    await submitExpenseForEmployee(validInput);
    expect(rpcMock).toHaveBeenCalledWith(
      "admin_submit_expense_for_employee_v2",
      expect.objectContaining({ p_status: "submitted", p_idempotency_key: null }),
    );
  });

  it("reports an idempotent replay distinctly from a fresh success", async () => {
    rpcMock.mockResolvedValue({
      data: {
        expense_id: "exp-1",
        status: "submitted",
        custom_fields_saved: 0,
        idempotent_replay: true,
      },
      error: null,
    });
    const result = await submitExpenseForEmployee({ ...validInput, idempotencyKey: "key-1" });
    expect(result.idempotentReplay).toBe(true);
  });
});

describe("submitExpenseForEmployee — error classification (Phase 30)", () => {
  const cases: Array<{ code?: string; message: string; expectedCode: string }> = [
    { code: "28000", message: "authentication required", expectedCode: "UNAUTHENTICATED" },
    { code: "42501", message: "not permitted: caller is not an active admin", expectedCode: "FORBIDDEN" },
    { message: "employee is not an active member of this organization", expectedCode: "EMPLOYEE_NOT_FOUND" },
    { message: "this employee is an accountant-cashier and cannot have expenses submitted", expectedCode: "EMPLOYEE_INACTIVE" },
    { message: "template_id does not belong to this organization", expectedCode: "CROSS_ORG" },
    { message: "a template field is not valid for this expense category", expectedCode: "CATEGORY_INVALID" },
    { message: "duplicate template_id in payload", expectedCode: "BRANCH_VALUE_INVALID" },
    { code: "23505", message: "idempotency key already used with a different request", expectedCode: "IDEMPOTENCY_CONFLICT" },
    { message: "title is required", expectedCode: "REQUIRED_FIELD_MISSING" },
    { message: "something truly unexpected", expectedCode: "EXPENSE_CREATE_FAILED" },
  ];

  it.each(cases)("classifies '$message' as $expectedCode", async ({ code, message, expectedCode }) => {
    rpcMock.mockResolvedValue({ data: null, error: { code, message } });
    await expect(submitExpenseForEmployee(validInput)).rejects.toMatchObject({
      code: expectedCode,
    });
  });

  it("throws AdminSubmitExpenseError, not a generic Error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(submitExpenseForEmployee(validInput)).rejects.toBeInstanceOf(AdminSubmitExpenseError);
  });

  it("throws EXPENSE_CREATE_FAILED when the RPC reports no error but also no expense_id", async () => {
    rpcMock.mockResolvedValue({ data: {}, error: null });
    await expect(submitExpenseForEmployee(validInput)).rejects.toMatchObject({
      code: "EXPENSE_CREATE_FAILED",
    });
  });
});

describe("submitBulkExpensesForEmployees — chunking and per-row results", () => {
  it("chunks rows at BULK_SUBMIT_CHUNK_SIZE and issues one RPC call per chunk", async () => {
    const rows = Array.from({ length: BULK_SUBMIT_CHUNK_SIZE + 5 }, (_, i) => ({
      rowIndex: i,
      employeeId: `emp-${i}`,
      title: "T",
      destination: "D",
      tripStart: "2026-09-01",
      tripEnd: "2026-09-01",
      category: "Travel",
      amount: 100,
      clientOperationId: `op-${i}`,
    }));
    rpcMock.mockImplementation((_name: string, params: { p_rows: unknown[] }) =>
      Promise.resolve({
        data: {
          results: params.p_rows.map((r: { row_index: number }) => ({
            row_index: r.row_index,
            ok: true,
            expense_id: `exp-${r.row_index}`,
          })),
        },
        error: null,
      }),
    );

    const results = await submitBulkExpensesForEmployees("org-1", rows);

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(BULK_SUBMIT_CHUNK_SIZE + 5);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("preserves per-row failure without aborting the rest of the batch", async () => {
    rpcMock.mockResolvedValue({
      data: {
        results: [
          { row_index: 0, ok: true, expense_id: "exp-0" },
          { row_index: 1, ok: false, error: "no employee found with employee_id \"BAD\"" },
        ],
      },
      error: null,
    });
    const rows = [
      { rowIndex: 0, employeeId: "emp-0", title: "T", destination: "D", tripStart: "2026-09-01", tripEnd: "2026-09-01", category: "Travel", amount: 100, clientOperationId: "op-0" },
      { rowIndex: 1, employeeId: "BAD", title: "T", destination: "D", tripStart: "2026-09-01", tripEnd: "2026-09-01", category: "Travel", amount: 100, clientOperationId: "op-1" },
    ];
    const results = await submitBulkExpensesForEmployees("org-1", rows);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain("no employee found");
  });

  it("passes each row's client_operation_id through as its idempotency key", async () => {
    rpcMock.mockImplementation((_name: string, params: { p_rows: Array<{ client_operation_id: string }> }) => {
      expect(params.p_rows[0].client_operation_id).toBe("bulk:abc123:0");
      return Promise.resolve({ data: { results: [] }, error: null });
    });
    await submitBulkExpensesForEmployees("org-1", [
      { rowIndex: 0, employeeId: "emp-0", title: "T", destination: "D", tripStart: "2026-09-01", tripEnd: "2026-09-01", category: "Travel", amount: 100, clientOperationId: "bulk:abc123:0" },
    ]);
  });
});

describe("finalizePendingReceiptsForExpense — receipt evidence integrity", () => {
  it("returns all-zero counts when there are no receipts, without calling the Edge Function", async () => {
    const outcome = await finalizePendingReceiptsForExpense({
      expenseId: "exp-1",
      organizationId: "org-1",
      adminUserId: "admin-1",
      receipts: [],
    });
    expect(outcome).toEqual({ finalizedCount: 0, pendingCount: 0, failedCount: 0, attachmentsInserted: 0 });
    expect(invokeFinalizeExpenseReceipts).not.toHaveBeenCalled();
  });

  it("a finalized receipt whose attachment-metadata insert fails counts as failed, not finalized", async () => {
    vi.mocked(invokeFinalizeExpenseReceipts).mockResolvedValue([
      { sourcePath: "temp/admin-1/a.jpg", desiredFinalPath: "exp-1/a.jpg", resolvedPath: "exp-1/a.jpg", status: "finalized", filename: "a.jpg" },
    ]);
    fromMock.mockReturnValue({
      insert: () => Promise.resolve({ error: { message: "insert failed" } }),
    });

    const outcome = await finalizePendingReceiptsForExpense({
      expenseId: "exp-1",
      organizationId: "org-1",
      adminUserId: "admin-1",
      receipts: [{ filename: "a.jpg" }],
    });

    // Storage said "finalized" but the metadata row never landed -- that is
    // NOT success: no attachment row means no evidence exists.
    expect(outcome.attachmentsInserted).toBe(0);
    expect(outcome.finalizedCount).toBe(0);
    expect(outcome.failedCount).toBe(1);
  });

  it("a genuinely failed finalization is counted as failed and never inserts a metadata row", async () => {
    vi.mocked(invokeFinalizeExpenseReceipts).mockResolvedValue([
      { sourcePath: "temp/admin-1/a.jpg", desiredFinalPath: "exp-1/a.jpg", resolvedPath: null, status: "failed", filename: "a.jpg" },
    ]);
    const insertSpy = vi.fn();
    fromMock.mockReturnValue({ insert: insertSpy });

    const outcome = await finalizePendingReceiptsForExpense({
      expenseId: "exp-1",
      organizationId: "org-1",
      adminUserId: "admin-1",
      receipts: [{ filename: "a.jpg" }],
    });

    expect(outcome.failedCount).toBe(1);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("a successful finalize + successful metadata insert counts as finalized with an attachment", async () => {
    vi.mocked(invokeFinalizeExpenseReceipts).mockResolvedValue([
      { sourcePath: "temp/admin-1/a.jpg", desiredFinalPath: "exp-1/a.jpg", resolvedPath: "exp-1/a.jpg", status: "finalized", filename: "a.jpg", fileUrl: "https://example/a.jpg" },
    ]);
    fromMock.mockReturnValue({ insert: () => Promise.resolve({ error: null }) });

    const outcome = await finalizePendingReceiptsForExpense({
      expenseId: "exp-1",
      organizationId: "org-1",
      adminUserId: "admin-1",
      receipts: [{ filename: "a.jpg" }],
    });

    expect(outcome.finalizedCount).toBe(1);
    expect(outcome.attachmentsInserted).toBe(1);
    expect(outcome.failedCount).toBe(0);
  });

  it("passes the ADMIN's own id as userId to the finalizer (temp path is the admin's, not the employee's)", async () => {
    vi.mocked(invokeFinalizeExpenseReceipts).mockResolvedValue([]);
    await finalizePendingReceiptsForExpense({
      expenseId: "exp-1",
      organizationId: "org-1",
      adminUserId: "admin-1",
      receipts: [{ filename: "a.jpg" }],
    });
    expect(invokeFinalizeExpenseReceipts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expenseId: "exp-1", userId: "admin-1" }),
    );
  });
});
