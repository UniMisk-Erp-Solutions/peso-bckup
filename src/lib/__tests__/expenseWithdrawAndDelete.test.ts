import { describe, expect, it, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const storageRemoveMock = vi.fn();
const storageFromMock = vi.fn(() => ({ remove: storageRemoveMock }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    storage: {
      from: (...args: unknown[]) => storageFromMock(...args),
    },
  },
}));

import {
  withdrawSubmittedExpense,
  deleteDraftExpense,
  ExpenseActionError,
} from "@/lib/expenseWithdrawAndDelete";

beforeEach(() => {
  rpcMock.mockReset();
  storageRemoveMock.mockReset();
  storageFromMock.mockClear();
});

describe("withdrawSubmittedExpense", () => {
  it("calls withdraw_submitted_expense_v1 with the expense id and returns the RPC's result", async () => {
    rpcMock.mockResolvedValue({
      data: { ok: true, expense_id: "exp-1", previous_status: "submitted", new_status: "draft", action: "withdrawn" },
      error: null,
    });

    const result = await withdrawSubmittedExpense("exp-1");

    expect(rpcMock).toHaveBeenCalledWith("withdraw_submitted_expense_v1", { p_expense_id: "exp-1" });
    expect(result).toEqual({ expenseId: "exp-1", action: "withdrawn" });
  });

  it("treats a repeated withdraw as an idempotent no-op, not an error", async () => {
    rpcMock.mockResolvedValue({
      data: { ok: true, expense_id: "exp-1", action: "already_withdrawn" },
      error: null,
    });

    const result = await withdrawSubmittedExpense("exp-1");
    expect(result.action).toBe("already_withdrawn");
  });

  it("throws ExpenseActionError with the server's message on a Postgres error (e.g. already reviewed)", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "Only a submitted expense can be withdrawn (current status: approved)." },
    });

    await expect(withdrawSubmittedExpense("exp-1")).rejects.toThrow(ExpenseActionError);
    await expect(withdrawSubmittedExpense("exp-1")).rejects.toThrow(/current status: approved/);
  });

  it("never reports success when the RPC returns a falsy ok with no error (defensive parity with the delete path)", async () => {
    rpcMock.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(withdrawSubmittedExpense("exp-1")).rejects.toThrow(ExpenseActionError);
  });
});

describe("deleteDraftExpense", () => {
  it("calls delete_draft_expense_v1 and removes any returned attachment paths from Storage", async () => {
    rpcMock.mockResolvedValue({
      data: {
        ok: true,
        expense_id: "exp-2",
        action: "deleted",
        attachment_paths: ["org-1/exp-2/receipt.jpg"],
        batch_id: null,
        organization_id: "org-1",
      },
      error: null,
    });
    storageRemoveMock.mockResolvedValue({ data: [], error: null });

    const result = await deleteDraftExpense("exp-2");

    expect(rpcMock).toHaveBeenCalledWith("delete_draft_expense_v1", { p_expense_id: "exp-2" });
    expect(storageFromMock).toHaveBeenCalledWith("receipts");
    expect(storageRemoveMock).toHaveBeenCalledWith(["org-1/exp-2/receipt.jpg"]);
    expect(result).toEqual({
      expenseId: "exp-2",
      action: "deleted",
      attachmentPaths: ["org-1/exp-2/receipt.jpg"],
      batchId: null,
      organizationId: "org-1",
    });
  });

  it("skips the Storage call entirely when there are no attachments", async () => {
    rpcMock.mockResolvedValue({
      data: { ok: true, expense_id: "exp-3", action: "deleted", attachment_paths: [], batch_id: null, organization_id: "org-1" },
      error: null,
    });

    await deleteDraftExpense("exp-3");

    expect(storageFromMock).not.toHaveBeenCalled();
  });

  it("still reports success even when the best-effort Storage cleanup fails", async () => {
    rpcMock.mockResolvedValue({
      data: {
        ok: true,
        expense_id: "exp-4",
        action: "deleted",
        attachment_paths: ["org-1/exp-4/receipt.jpg"],
        batch_id: null,
        organization_id: "org-1",
      },
      error: null,
    });
    storageRemoveMock.mockRejectedValue(new Error("network error"));

    const result = await deleteDraftExpense("exp-4");
    expect(result.action).toBe("deleted");
  });

  it("surfaces batch_id/organization_id so the caller can resync a batch's aggregates", async () => {
    rpcMock.mockResolvedValue({
      data: {
        ok: true,
        expense_id: "exp-5",
        action: "deleted",
        attachment_paths: [],
        batch_id: "batch-1",
        organization_id: "org-1",
      },
      error: null,
    });

    const result = await deleteDraftExpense("exp-5");
    expect(result.batchId).toBe("batch-1");
    expect(result.organizationId).toBe("org-1");
  });

  it("treats deleting an already-deleted expense as an idempotent no-op, not an error", async () => {
    rpcMock.mockResolvedValue({
      data: { ok: true, expense_id: "exp-6", action: "already_deleted", attachment_paths: [] },
      error: null,
    });

    const result = await deleteDraftExpense("exp-6");
    expect(result.action).toBe("already_deleted");
  });

  it("throws ExpenseActionError with the server's message when the expense was previously submitted and withdrawn", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        message:
          "This expense was previously submitted and withdrawn, so it carries audit history and cannot be permanently deleted. You can edit it and resubmit it instead.",
      },
    });

    await expect(deleteDraftExpense("exp-7")).rejects.toThrow(/previously submitted and withdrawn/);
  });

  it("never reports success when the RPC returns a falsy ok with no error", async () => {
    rpcMock.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(deleteDraftExpense("exp-8")).rejects.toThrow(ExpenseActionError);
  });
});
