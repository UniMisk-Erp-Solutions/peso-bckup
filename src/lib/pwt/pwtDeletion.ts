/**
 * Deletion sync (expense deleted in PesoWise -> corrected in TallyPrime): browser client. Read-only history plus a manual retry of a
 * BLOCKED correction. Corrections themselves are detected and queued by the database and applied by the connector automatically.
 */
import { supabase } from "@/integrations/supabase/client";

export type PwtDeletionStatus = "queued" | "claimed" | "completed" | "blocked" | "cancelled";
export type PwtDeletionAction = "delete_voucher" | "alter_voucher" | "reversal_voucher" | "already_gone";

export interface PwtDeletion {
  id: string;
  transaction_number: string | null;
  voucher_number: string;
  voucher_date: string;
  amount: number;
  employee_ledger: string | null;
  status: PwtDeletionStatus;
  action: PwtDeletionAction | null;
  attempts: number;
  error: string | null;
  detected_via: string;
  created_at: string;
  completed_at: string | null;
}

export const PWT_DELETION_STATUS_LABEL: Record<PwtDeletionStatus, string> = {
  queued: "Waiting for the Tally connector",
  claimed: "Correcting in Tally",
  completed: "Corrected in Tally",
  blocked: "Needs attention",
  cancelled: "Cancelled (expense restored)",
};

export const PWT_DELETION_ACTION_LABEL: Record<PwtDeletionAction, string> = {
  delete_voucher: "Voucher deleted",
  alter_voucher: "Amount removed from voucher",
  reversal_voucher: "Reversal voucher posted",
  already_gone: "Voucher was already gone",
};

/** One plain-language line for a correction. */
export function describeDeletion(d: PwtDeletion): string {
  const what = `${d.transaction_number ? `Expense ${d.transaction_number}` : "Expense"} · ${d.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })} · voucher ${d.voucher_number}`;
  switch (d.status) {
    case "completed":
      return `${what} — ${d.action ? PWT_DELETION_ACTION_LABEL[d.action] : "corrected"}.`;
    case "blocked":
      return `${what} — not changed in Tally: ${d.error ?? "needs a manual check"}`;
    case "queued":
      return `${what} — ${d.error ? `will retry (${d.error})` : "waiting for the connector; it runs by itself when TallyPrime is open."}`;
    default:
      return what;
  }
}

type RpcResult<T> = Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = <T,>(name: string, args: Record<string, unknown>): RpcResult<T> =>
  (supabase as unknown as { rpc: (n: string, a: Record<string, unknown>) => RpcResult<T> }).rpc(name, args);

export async function listPwtDeletions(organizationId: string, limit = 10): Promise<PwtDeletion[]> {
  const { data, error } = await rpc<PwtDeletion[]>("pwt_list_deletions_v1", { p_organization_id: organizationId, p_limit: limit });
  if (error) throw new Error(error.message);
  return (data ?? []).map((d) => ({ ...d, amount: Number(d.amount) }));
}

export async function retryPwtDeletion(organizationId: string, jobId: string): Promise<boolean> {
  const { data, error } = await rpc<boolean>("pwt_retry_deletion_v1", { p_organization_id: organizationId, p_job: jobId });
  if (error) throw new Error(error.message);
  return data === true;
}
