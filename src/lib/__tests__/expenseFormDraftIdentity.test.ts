import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DOC-148: the logical submission id rides in the browser's DURABLE recoverable form
 * (localStorage), not in sessionStorage. A browser restart (module state gone, sessionStorage
 * cleared) must still restore it, so the next Submit resolves to the same server row.
 */
const payload = (csid: string) => ({
  expense: { title: "Taxi", destination: "Mumbai", expense_date: "2026-10-10T00:00:00.000Z", purpose: "", amount: 120, category: "Travel" },
  formFieldValues: {},
  branchValues: {},
  attachments: [],
  sessionTempFilenames: [],
  sessionTempMeta: [],
  clientSubmissionId: csid,
});

describe("recoverable form carries the logical submission id across a browser restart", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("save -> restart (fresh module + sessionStorage wiped) -> same id restored from localStorage", async () => {
    const first = await import("@/lib/expenseFormDraft");
    first.saveExpenseFormDraft("u1", "o1", payload("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "new", { force: true });

    // --- browser restart ---
    sessionStorage.clear();
    vi.resetModules();
    const second = await import("@/lib/expenseFormDraft");
    const restored = second.loadExpenseFormDraft("u1", "o1", "new");
    expect(restored?.clientSubmissionId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(restored?.expense.title).toBe("Taxi");
  });

  it("is restored from localStorage alone, with nothing in sessionStorage", async () => {
    const lib = await import("@/lib/expenseFormDraft");
    lib.saveExpenseFormDraft("u1", "o1", payload("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "new", { force: true });
    vi.resetModules();
    sessionStorage.clear(); // and nothing in sessionStorage to fall back on
    const again = await import("@/lib/expenseFormDraft");
    expect(again.loadExpenseFormDraft("u1", "o1", "new")?.clientSubmissionId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("an older saved form without an id still loads (a fresh id is minted by the form)", async () => {
    const lib = await import("@/lib/expenseFormDraft");
    const { clientSubmissionId: _omit, ...legacy } = payload("x");
    lib.saveExpenseFormDraft("u1", "o1", legacy, "new", { force: true });
    expect(lib.loadExpenseFormDraft("u1", "o1", "new")?.clientSubmissionId).toBeUndefined();
  });

  it("a successful submit clears the form, so the NEXT form gets a different logical id", async () => {
    const lib = await import("@/lib/expenseFormDraft");
    lib.saveExpenseFormDraft("u1", "o1", payload("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), "new", { force: true });
    lib.clearExpenseFormDraft("u1", "o1", "new");
    vi.resetModules();
    const fresh = await import("@/lib/expenseFormDraft");
    expect(fresh.loadExpenseFormDraft("u1", "o1", "new")).toBeNull();
  });
});
