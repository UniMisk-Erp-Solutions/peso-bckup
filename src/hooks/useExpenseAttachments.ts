import { useCallback, useEffect, useRef, useState } from "react";
import { createLatestRequestGuard } from "@/lib/latestRequestGuard";
import { filterAttachmentsForExpense } from "@/lib/expenseAttachmentIdentity";

export type ExpenseAttachmentsStatus = "idle" | "loading" | "loaded" | "error";

interface Snapshot<T> {
  expenseId: string | null;
  items: T[];
  status: ExpenseAttachmentsStatus;
}

const idle = <T,>(): Snapshot<T> => ({ expenseId: null, items: [], status: "idle" });

/**
 * Attachments of the expense currently on screen - and ONLY of that expense.
 *
 * - The result is derived from the snapshot's owner id on every render, so on the very render in which
 *   the selected expense changes the previous expense's rows are already gone (no effect-delay flash).
 * - A response is applied only if its request is still the latest one; a late response for a previous
 *   expense, a request that finished after the modal closed, and a failure of an old request are ignored.
 * - Exactly one `load` call per selected expense (plus one per explicit `reload`). No polling.
 */
export function useExpenseAttachments<T extends { id: string; expense_id?: string | null }>(params: {
  expenseId: string | null;
  load: (expenseId: string) => Promise<T[]>;
}) {
  const { expenseId, load } = params;
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(idle);
  const guardRef = useRef(createLatestRequestGuard());
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback((id: string) => {
    const ticket = guardRef.current.begin();
    setSnapshot((prev) =>
      prev.expenseId === id ? { ...prev, status: "loading" } : { expenseId: id, items: [], status: "loading" },
    );
    loadRef
      .current(id)
      .then((rows) => {
        if (!ticket.isCurrent()) return;
        setSnapshot({ expenseId: id, items: filterAttachmentsForExpense(rows, id), status: "loaded" });
      })
      .catch((error: unknown) => {
        if (!ticket.isCurrent()) return;
        console.error("Error fetching attachments:", error instanceof Error ? error.message : "request failed");
        setSnapshot({ expenseId: id, items: [], status: "error" });
      });
  }, []);

  useEffect(() => {
    const guard = guardRef.current;
    if (!expenseId) {
      guard.invalidate();
      setSnapshot(idle<T>());
      return;
    }
    run(expenseId);
    // Switching expense, closing the modal or unmounting orphans whatever is in flight.
    return () => guard.invalidate();
  }, [expenseId, run]);

  const reload = useCallback(() => {
    if (expenseId) run(expenseId);
  }, [expenseId, run]);

  const owned = expenseId !== null && snapshot.expenseId === expenseId;
  return {
    attachments: owned ? snapshot.items : ([] as T[]),
    status: (owned ? snapshot.status : expenseId ? "loading" : "idle") as ExpenseAttachmentsStatus,
    reload,
  };
}
