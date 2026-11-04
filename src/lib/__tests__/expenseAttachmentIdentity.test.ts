import { afterEach, describe, expect, it, vi } from "vitest";
import { filterAttachmentsForExpense } from "@/lib/expenseAttachmentIdentity";

const expenseA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const expenseB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filterAttachmentsForExpense", () => {
  it("drops a row owned by another expense and warns with short prefixes only", () => {
    const warn = vi.fn();
    const kept = filterAttachmentsForExpense(
      [
        { id: "11111111-1111-1111-1111-111111111111", expense_id: expenseA, filename: "a.jpg" },
        { id: "22222222-2222-2222-2222-222222222222", expense_id: expenseB, filename: "b.jpg" },
        { id: "33333333-3333-3333-3333-333333333333", filename: "unscoped.jpg" },
      ],
      expenseA,
      warn,
    );

    expect(kept.map((row) => row.id)).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "33333333-3333-3333-3333-333333333333",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, detail] = warn.mock.calls[0];
    expect(message).toContain("different expense");
    expect(detail).toEqual({ row: "22222222", expected: "aaaaaaaa", actual: "bbbbbbbb" });
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain(expenseB);
    expect(serialized).not.toContain("b.jpg");
    expect(serialized).not.toContain("file_url");
  });

  it("keeps every row when each one belongs to the expense on screen", () => {
    const warn = vi.fn();
    const rows = [
      { id: "1", expense_id: expenseA },
      { id: "2", expense_id: expenseA },
    ];
    expect(filterAttachmentsForExpense(rows, expenseA, warn)).toEqual(rows);
    expect(warn).not.toHaveBeenCalled();
  });
});
