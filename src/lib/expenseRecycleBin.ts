/**
 * 30-day Expense Recycle Bin service layer (DOC-129).
 *
 * Replaces the old immediate hard-delete UI action: "Delete" now moves a
 * draft expense to a soft-deleted state (trash_expense_v1) instead of
 * erasing it. Restoring (restore_trashed_expense_v1) always returns it as a
 * draft -- never back to submitted/reviewer queue/approved. Permanent
 * removal only ever happens automatically, 30 days later, via the
 * service_role-only purge job -- there is deliberately no "delete forever"
 * button in this UI (see DOC-129 for the reasoning).
 *
 * Every RPC here returns `{ ok: true, ... }` on success and never a falsy
 * `ok` -- a failure always comes back as a thrown Postgres error, which
 * `error` below carries. Matches the same contract expenseWithdrawAndDelete.ts
 * already established.
 */
import { supabase } from "@/integrations/supabase/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export class ExpenseActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpenseActionError";
  }
}

export type TrashExpenseResult = {
  expenseId: string;
  action: "trashed" | "already_trashed";
  purgeAfter: string;
};

export type RestoreTrashedExpenseResult = {
  expenseId: string;
  action: "restored";
  status: "draft";
};

export type TrashedExpense = {
  id: string;
  transactionNumber: string | null;
  title: string;
  destination: string;
  tripStart: string;
  totalAmount: number;
  statusBefore: string;
  deletedAt: string;
  purgeAfter: string;
};

/** Moves the caller's own draft expense to the Recycle Bin. Never erases anything. */
export async function trashExpense(expenseId: string): Promise<TrashExpenseResult> {
  const { data, error } = await db.rpc("trash_expense_v1", { p_expense_id: expenseId });

  if (error) {
    throw new ExpenseActionError(error.message || "Failed to move expense to Recycle Bin");
  }
  if (!data?.ok) {
    throw new ExpenseActionError("Failed to move expense to Recycle Bin");
  }

  return { expenseId: data.expense_id, action: data.action, purgeAfter: data.purge_after };
}

/** Restores the caller's own trashed expense, provided its 30-day retention has not expired. Always returns as draft. */
export async function restoreTrashedExpense(expenseId: string): Promise<RestoreTrashedExpenseResult> {
  const { data, error } = await db.rpc("restore_trashed_expense_v1", { p_expense_id: expenseId });

  if (error) {
    throw new ExpenseActionError(error.message || "Failed to restore expense");
  }
  if (!data?.ok) {
    throw new ExpenseActionError("Failed to restore expense");
  }

  return { expenseId: data.expense_id, action: data.action, status: data.status };
}

/** Lists not-yet-expired Recycle Bin expenses for the given organization, scoped by the caller's own view permissions. */
export async function listTrashedExpenses(organizationId: string): Promise<TrashedExpense[]> {
  const { data, error } = await db.rpc("list_trashed_expenses_v1", { p_organization_id: organizationId });

  if (error) {
    throw new ExpenseActionError(error.message || "Failed to load Recycle Bin");
  }

  const rows: unknown[] = Array.isArray(data) ? data : [];
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      transactionNumber: (r.transaction_number as string | null) ?? null,
      title: String(r.title ?? ""),
      destination: String(r.destination ?? ""),
      tripStart: String(r.trip_start ?? ""),
      totalAmount: Number(r.total_amount ?? 0),
      statusBefore: String(r.status_before ?? ""),
      deletedAt: String(r.deleted_at ?? ""),
      purgeAfter: String(r.purge_after ?? ""),
    };
  });
}

/** Days remaining before automatic permanent purge (0 means "purges today"). Never negative. */
export function daysUntilPurge(purgeAfterIso: string, now: Date = new Date()): number {
  const purgeAfter = new Date(purgeAfterIso);
  const msRemaining = purgeAfter.getTime() - now.getTime();
  return Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
}

/** Human copy for the Recycle Bin's remaining-time column, matching the product spec's exact wording. */
export function purgeCountdownLabel(purgeAfterIso: string, now: Date = new Date()): string {
  const days = daysUntilPurge(purgeAfterIso, now);
  if (days <= 0) return "Deletes today";
  if (days === 1) return "Deletes tomorrow";
  return `${days} days remaining`;
}
