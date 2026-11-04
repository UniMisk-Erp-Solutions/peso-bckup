import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useExpenseAttachments } from "@/hooks/useExpenseAttachments";

interface Row {
  id: string;
  expense_id: string;
  file_url: string;
}

const expenseA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const expenseB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rows(expenseId: string, count = 4): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${expenseId.slice(0, 8)}-${index}`,
    expense_id: expenseId,
    file_url: `https://files.example/${expenseId.slice(0, 8)}/${index}`,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useExpenseAttachments race", () => {
  it("ignores a slow response for A after a fast response for B", async () => {
    const pending: Array<{ id: string; gate: ReturnType<typeof deferred<Row[]>> }> = [];
    const load = (id: string) => {
      const gate = deferred<Row[]>();
      pending.push({ id, gate });
      return gate.promise;
    };

    const { result, rerender } = renderHook(
      ({ expenseId }: { expenseId: string | null }) => useExpenseAttachments({ expenseId, load }),
      { initialProps: { expenseId: expenseA as string | null } },
    );

    expect(result.current.attachments).toEqual([]);
    expect(result.current.status).toBe("loading");

    rerender({ expenseId: expenseB });
    expect(result.current.attachments).toEqual([]);
    expect(result.current.status).toBe("loading");

    await act(async () => {
      pending[1].gate.resolve(rows(expenseB));
    });
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.attachments.map((row) => row.expense_id)).toEqual([
      expenseB,
      expenseB,
      expenseB,
      expenseB,
    ]);

    await act(async () => {
      pending[0].gate.resolve(rows(expenseA));
    });
    expect(result.current.attachments.every((row) => row.expense_id === expenseB)).toBe(true);
    expect(result.current.status).toBe("loaded");
  });

  it("clears A's attachments immediately when B is selected, then shows only B", async () => {
    const pending: Array<{ id: string; gate: ReturnType<typeof deferred<Row[]>> }> = [];
    const load = (id: string) => {
      const gate = deferred<Row[]>();
      pending.push({ id, gate });
      return gate.promise;
    };

    const { result, rerender } = renderHook(
      ({ expenseId }: { expenseId: string | null }) => useExpenseAttachments({ expenseId, load }),
      { initialProps: { expenseId: expenseA as string | null } },
    );
    await act(async () => {
      pending[0].gate.resolve(rows(expenseA));
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(4));

    rerender({ expenseId: expenseB });
    expect(result.current.attachments).toEqual([]);
    expect(result.current.status).toBe("loading");
    expect(result.current.attachments.some((row) => row.file_url.includes("aaaaaaaa"))).toBe(false);

    await act(async () => {
      pending[1].gate.resolve(rows(expenseB));
    });
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.attachments.every((row) => row.expense_id === expenseB)).toBe(true);
  });

  it("keeps the final selection after rapid A/B/A/B responses arrive out of order", async () => {
    const pending: Array<{ id: string; gate: ReturnType<typeof deferred<Row[]>> }> = [];
    const load = (id: string) => {
      const gate = deferred<Row[]>();
      pending.push({ id, gate });
      return gate.promise;
    };
    const { result, rerender } = renderHook(
      ({ expenseId }: { expenseId: string | null }) => useExpenseAttachments({ expenseId, load }),
      { initialProps: { expenseId: expenseA as string | null } },
    );
    rerender({ expenseId: expenseB });
    rerender({ expenseId: expenseA });
    rerender({ expenseId: expenseB });
    expect(pending.map((call) => call.id)).toEqual([expenseA, expenseB, expenseA, expenseB]);

    await act(async () => {
      pending[2].gate.resolve(rows(expenseA, 1));
      pending[0].gate.resolve(rows(expenseA, 2));
      pending[1].gate.resolve(rows(expenseB, 3));
      pending[3].gate.resolve(rows(expenseB, 4));
    });
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.attachments).toHaveLength(4);
    expect(result.current.attachments.every((row) => row.expense_id === expenseB)).toBe(true);
  });

  it("does not let A's failure replace B's in-flight state", async () => {
    const pending: Array<{ id: string; gate: ReturnType<typeof deferred<Row[]>> }> = [];
    const load = (id: string) => {
      const gate = deferred<Row[]>();
      pending.push({ id, gate });
      return gate.promise;
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, rerender } = renderHook(
      ({ expenseId }: { expenseId: string | null }) => useExpenseAttachments({ expenseId, load }),
      { initialProps: { expenseId: expenseA as string | null } },
    );
    rerender({ expenseId: expenseB });
    await act(async () => {
      pending[0].gate.reject(new Error("A failed"));
    });
    expect(result.current.status).toBe("loading");
    expect(result.current.attachments).toEqual([]);

    await act(async () => {
      pending[1].gate.resolve(rows(expenseB));
    });
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.attachments.every((row) => row.expense_id === expenseB)).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("shows B's error and does not keep A's attachments", async () => {
    const pending: Array<{ id: string; gate: ReturnType<typeof deferred<Row[]>> }> = [];
    const load = (id: string) => {
      const gate = deferred<Row[]>();
      pending.push({ id, gate });
      return gate.promise;
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, rerender } = renderHook(
      ({ expenseId }: { expenseId: string | null }) => useExpenseAttachments({ expenseId, load }),
      { initialProps: { expenseId: expenseA as string | null } },
    );
    await act(async () => {
      pending[0].gate.resolve(rows(expenseA));
    });
    await waitFor(() => expect(result.current.status).toBe("loaded"));

    rerender({ expenseId: expenseB });
    expect(result.current.attachments).toEqual([]);
    await act(async () => {
      pending[1].gate.reject(new Error("B failed"));
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.attachments).toEqual([]);
  });

  it("stays closed when a response arrives after the review is dismissed", async () => {
    const pending: Array<{ id: string; gate: ReturnType<typeof deferred<Row[]>> }> = [];
    const load = (id: string) => {
      const gate = deferred<Row[]>();
      pending.push({ id, gate });
      return gate.promise;
    };
    const { result, rerender } = renderHook(
      ({ expenseId }: { expenseId: string | null }) => useExpenseAttachments({ expenseId, load }),
      { initialProps: { expenseId: expenseA as string | null } },
    );
    rerender({ expenseId: null });
    expect(result.current.status).toBe("idle");
    expect(result.current.attachments).toEqual([]);
    await act(async () => {
      pending[0].gate.resolve(rows(expenseA));
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.attachments).toEqual([]);
  });

  it("drops a mismatched attachment row and keeps the rows for the selected expense", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = vi.fn(async () => [
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", expense_id: expenseB, file_url: "https://files.example/wrong" },
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", expense_id: expenseA, file_url: "https://files.example/right" },
    ]);
    const { result } = renderHook(() => useExpenseAttachments({ expenseId: expenseA, load }));
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.attachments.map((row) => row.id)).toEqual(["dddddddd-dddd-dddd-dddd-dddddddddddd"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(expenseB);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("wrong");
  });

  it("issues one load per selected expense and does not refetch when the loader identity changes", async () => {
    const calls: string[] = [];
    const load = (id: string) => {
      calls.push(id);
      return Promise.resolve(rows(id, 1));
    };
    const { result, rerender } = renderHook(
      ({ expenseId, loadFn }: { expenseId: string; loadFn: typeof load }) =>
        useExpenseAttachments({ expenseId, load: loadFn }),
      { initialProps: { expenseId: expenseA, loadFn: load } },
    );
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    rerender({ expenseId: expenseA, loadFn: (id: string) => load(id) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual([expenseA]);

    rerender({ expenseId: expenseB, loadFn: load });
    await waitFor(() => expect(result.current.attachments[0]?.expense_id).toBe(expenseB));
    expect(calls).toEqual([expenseA, expenseB]);
  });
});
