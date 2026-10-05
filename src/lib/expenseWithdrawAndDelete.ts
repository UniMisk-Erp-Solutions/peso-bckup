/**
 * Withdraw / delete service layer for "My Expenses" (DOC-128).
 *
 * Both actions call an atomic, SECURITY DEFINER RPC
 * (supabase/migrations/20260922090000_expense_withdraw_and_safe_draft_delete_v1.sql)
 * instead of the previous multi-call, unverified browser flow. Both RPCs
 * return `{ ok: true, ... }` on success and never a falsy `ok` — a failure
 * always comes back as a thrown Postgres error (RAISE EXCEPTION), which
 * `error` below carries. There is deliberately no "0 rows affected but no
 * error" outcome to misinterpret as success, unlike the raw
 * `.from("expenses").delete()` call this replaces.
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

export type WithdrawExpenseResult = {
  expenseId: string;
  action: "withdrawn" | "already_withdrawn";
};

export type DeleteDraftExpenseResult = {
  expenseId: string;
  action: "deleted" | "already_deleted";
  attachmentPaths: string[];
  /** Present when the deleted draft was a batch line item, so the caller can resync the parent batch's aggregates. */
  batchId: string | null;
  organizationId: string | null;
};

/** Recalls the caller's own submitted expense to draft. Never deletes anything. */
export async function withdrawSubmittedExpense(expenseId: string): Promise<WithdrawExpenseResult> {
  const { data, error } = await db.rpc("withdraw_submitted_expense_v1", { p_expense_id: expenseId });

  if (error) {
    throw new ExpenseActionError(error.message || "Failed to withdraw expense");
  }
  if (!data?.ok) {
    throw new ExpenseActionError("Failed to withdraw expense");
  }

  return { expenseId: data.expense_id, action: data.action };
}

/**
 * Permanently deletes the caller's own draft expense (never one that was
 * ever submitted). Best-effort removes its receipt(s) from Storage
 * afterwards — a failure there does not roll back the delete, since the
 * database rows are already gone and correct.
 */
export async function deleteDraftExpense(expenseId: string): Promise<DeleteDraftExpenseResult> {
  const { data, error } = await db.rpc("delete_draft_expense_v1", { p_expense_id: expenseId });

  if (error) {
    throw new ExpenseActionError(error.message || "Failed to delete expense");
  }
  if (!data?.ok) {
    throw new ExpenseActionError("Failed to delete expense");
  }

  const attachmentPaths: string[] = Array.isArray(data.attachment_paths) ? data.attachment_paths : [];

  if (attachmentPaths.length > 0) {
    try {
      await db.storage.from("receipts").remove(attachmentPaths);
    } catch (storageError) {
      // Non-fatal: the expense and its rows are already gone. A leaked
      // Storage object for a never-submitted draft is not an audit gap.
      console.error("Failed to remove receipt(s) from Storage after delete:", storageError);
    }
  }

  return {
    expenseId: data.expense_id,
    action: data.action,
    attachmentPaths,
    batchId: data.batch_id ?? null,
    organizationId: data.organization_id ?? null,
  };
}
