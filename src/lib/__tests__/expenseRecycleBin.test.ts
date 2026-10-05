import { describe, expect, it, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import {
  trashExpense,
  restoreTrashedExpense,
  listTrashedExpenses,
  daysUntilPurge,
  purgeCountdownLabel,
  ExpenseActionError,
} from "@/lib/expenseRecycleBin";

beforeEach(() => {
  rpcMock.mockReset();
});

describe("trashExpense", () => {
  it("calls trash_expense_v1 with the expense id and returns the RPC's result", async () => {
    rpcMock.mockResolvedValue({
      data: { ok: true, expense_id: "exp-1", action: "trashed", purge_after: "2026-10-22T00:00:00Z" },
      error: null,
    });

    const result = await trashExpense("exp-1");

    expect(rpcMock).toHaveBeenCalledWith("trash_expense_v1", { p_expense_id: "exp-1" });
    expect(result).toEqual({ expenseId: "exp-1", action: "trashed", purgeAfter: "2026-10-22T00:00:00Z" });
  });

  it("treats a repeated trash as an idempotent no-op, not an error", async () => {
    rpcMock.mockResolvedValue({
      data: { ok: true, expense_id: "exp-1", action: "already_trashed", purge_after: "2026-10-22T00:00:00Z" },
      error: null,
    });
    const result = await trashExpense("exp-1");
    expect(result.action).toBe("already_trashed");
  });

  it("throws ExpenseActionError with the server's message when the expense isn't a draft", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "Only a draft expense can be moved to the Recycle Bin (current status: submitted)." },
    });
    await expect(trashExpense("exp-1")).rejects.toThrow(/current status: submitted/);
  });

  it("never reports success when the RPC returns a falsy ok with no error", async () => {
    rpcMock.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(trashExpense("exp-1")).rejects.toThrow(ExpenseActionError);
  });
});

describe("restoreTrashedExpense", () => {
  it("calls restore_trashed_expense_v1 and returns draft status", async () => {
    rpcMock.mockResolvedValue({
      data: { ok: true, expense_id: "exp-2", action: "restored", status: "draft" },
      error: null,
    });

    const result = await restoreTrashedExpense("exp-2");

    expect(rpcMock).toHaveBeenCalledWith("restore_trashed_expense_v1", { p_expense_id: "exp-2" });
    expect(result).toEqual({ expenseId: "exp-2", action: "restored", status: "draft" });
  });

  it("throws ExpenseActionError with the server's message when retention has expired", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "The 30-day retention period for this expense has expired; it can no longer be restored." },
    });
    await expect(restoreTrashedExpense("exp-2")).rejects.toThrow(/retention period.*expired/);
  });

  it("never reports success when the RPC returns a falsy ok with no error", async () => {
    rpcMock.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(restoreTrashedExpense("exp-2")).rejects.toThrow(ExpenseActionError);
  });
});

describe("listTrashedExpenses", () => {
  it("calls list_trashed_expenses_v1 and maps rows into the client shape", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          id: "exp-3",
          transaction_number: "00042",
          title: "Client visit",
          destination: "Ahmedabad",
          trip_start: "2026-09-01",
          total_amount: 500,
          status_before: "draft",
          deleted_at: "2026-09-22T10:00:00Z",
          purge_after: "2026-10-22T10:00:00Z",
        },
      ],
      error: null,
    });

    const rows = await listTrashedExpenses("org-1");

    expect(rpcMock).toHaveBeenCalledWith("list_trashed_expenses_v1", { p_organization_id: "org-1" });
    expect(rows).toEqual([
      {
        id: "exp-3",
        transactionNumber: "00042",
        title: "Client visit",
        destination: "Ahmedabad",
        tripStart: "2026-09-01",
        totalAmount: 500,
        statusBefore: "draft",
        deletedAt: "2026-09-22T10:00:00Z",
        purgeAfter: "2026-10-22T10:00:00Z",
      },
    ]);
  });

  it("returns an empty list rather than throwing when the RPC returns no rows", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    expect(await listTrashedExpenses("org-1")).toEqual([]);
  });

  it("throws ExpenseActionError on a server error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(listTrashedExpenses("org-1")).rejects.toThrow(ExpenseActionError);
  });
});

describe("daysUntilPurge / purgeCountdownLabel", () => {
  const now = new Date("2026-09-22T00:00:00Z");

  it("counts whole days remaining, rounding up a partial day", () => {
    expect(daysUntilPurge("2026-10-22T00:00:00Z", now)).toBe(30);
    expect(daysUntilPurge("2026-09-23T00:00:00Z", now)).toBe(1);
    expect(daysUntilPurge("2026-09-22T12:00:00Z", now)).toBe(1);
  });

  it("never goes negative once purge_after has passed", () => {
    expect(daysUntilPurge("2026-09-20T00:00:00Z", now)).toBe(0);
  });

  it("matches the product spec's exact wording", () => {
    expect(purgeCountdownLabel("2026-10-21T00:00:00Z", now)).toBe("29 days remaining");
    expect(purgeCountdownLabel("2026-09-30T00:00:00Z", now)).toBe("8 days remaining");
    expect(purgeCountdownLabel("2026-09-23T00:00:00Z", now)).toBe("Deletes tomorrow");
    expect(purgeCountdownLabel("2026-09-20T00:00:00Z", now)).toBe("Deletes today");
  });
});
