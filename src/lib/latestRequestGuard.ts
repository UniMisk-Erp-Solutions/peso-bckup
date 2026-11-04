/**
 * Hotfix hotfix/review-attachment-state-race - "only the newest request may write state".
 *
 * A review modal that fetches per-expense data must ignore a response that belongs to an expense
 * the reviewer has already moved away from. Response order is not guaranteed (a slow request for
 * expense A can finish AFTER the request for expense B), so ordering of arrival is never relied on:
 * every request takes a ticket, and a ticket is only valid until the next `begin()` or `invalidate()`.
 */
export interface RequestTicket {
  /** True while no newer request has started and the guard has not been invalidated. */
  isCurrent(): boolean;
}

export interface LatestRequestGuard {
  begin(): RequestTicket;
  /** Invalidates every outstanding ticket (modal closed, component unmounted, expense changed). */
  invalidate(): void;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let generation = 0;
  return {
    begin() {
      const mine = ++generation;
      return { isCurrent: () => mine === generation };
    },
    invalidate() {
      generation += 1;
    },
  };
}

/**
 * A response may update the screen only when its ticket is still the latest one AND the expense
 * it was fetched for is still the expense on screen. Either check alone is not enough: a ticket
 * can still look current for a moment, and an aborted request can already have resolved.
 */
export function responseStillCurrent(
  ticket: RequestTicket,
  requestExpenseId: string,
  activeExpenseId: string | null,
): boolean {
  return ticket.isCurrent() && activeExpenseId === requestExpenseId;
}

/**
 * Detect an expense switch during render, before paint and before a queued response microtask.
 * Call `invalidate` only when the id actually changes so a same-expense refresh is left alone.
 */
export function applyExpenseScopeChange(
  scopeId: string | null,
  expenseId: string | null,
  invalidate: () => void,
): { scopeId: string | null; changed: boolean } {
  if (scopeId === expenseId) return { scopeId, changed: false };
  invalidate();
  return { scopeId: expenseId, changed: true };
}
