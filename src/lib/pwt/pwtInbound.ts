/**
 * "Sync from Tally" (employee payments entered in TallyPrime -> PesoWise balances): browser client.
 * One request starts a job; the paired Windows connector reads the vouchers; the database credits balances through the existing
 * balance engine. The browser only starts the job and reads progress and results.
 */
import { supabase } from "@/integrations/supabase/client";

export type PwtInboundStatus = "queued" | "fetching" | "processing" | "completed" | "needs_attention" | "failed" | "cancelled";

export interface PwtInboundJob {
  id: string;
  status: PwtInboundStatus;
  tally_company: string;
  created_at: string;
  completed_at: string | null;
  vouchers_fetched: number;
  imported_count: number;
  already_imported_count: number;
  skipped_count: number;
  unmatched_count: number;
  failed_count: number;
  flagged_count: number;
  imported_amount: number;
  progress_current: number;
  progress_total: number | null;
  error: string | null;
}

export interface PwtInboundProblem {
  voucher_number: string | null;
  voucher_date: string | null;
  ledger_name: string;
  amount: number;
  state: string;
  reason: string | null;
}

export const PWT_INBOUND_STATUS_LABEL: Record<PwtInboundStatus, string> = {
  queued: "Waiting for the Tally connector",
  fetching: "Reading vouchers from Tally",
  processing: "Applying payments",
  completed: "Completed",
  needs_attention: "Completed, needs attention",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const isInboundActive = (s: PwtInboundStatus) => s === "queued" || s === "fetching" || s === "processing";

export const PWT_INBOUND_STATE_LABEL: Record<string, string> = {
  unmatched: "Employee not matched",
  ambiguous: "Ambiguous employee",
  skipped: "Skipped",
  failed: "Failed",
  changed_after_import: "Edited in Tally after import",
  deleted_in_tally: "Deleted in Tally after import",
};

/** One plain-language line for a job. */
export function describeInboundJob(j: PwtInboundJob, connectorOnline?: boolean): string {
  switch (j.status) {
    case "queued":
      return connectorOnline === false
        ? "Waiting: the connector on the Tally PC is offline. Switch it on and open the paired company in TallyPrime; this sync then runs by itself."
        : "Waiting for the connector on the Tally PC to pick this up.";
    case "fetching":
      return j.progress_total != null
        ? `Reading vouchers from Tally: ${j.progress_current.toLocaleString()} of ${j.progress_total.toLocaleString()}.`
        : "Reading vouchers from Tally…";
    case "processing":
      return "Matching employees and applying payments…";
    case "failed":
      return j.error ?? "The sync failed before any payment was applied.";
    default: {
      const parts = [`${j.vouchers_fetched} voucher(s) read`, `${j.imported_count} imported`];
      if (j.already_imported_count) parts.push(`${j.already_imported_count} already imported`);
      if (j.unmatched_count) parts.push(`${j.unmatched_count} employee(s) not matched`);
      if (j.skipped_count) parts.push(`${j.skipped_count} skipped`);
      if (j.failed_count) parts.push(`${j.failed_count} failed`);
      if (j.flagged_count) parts.push(`${j.flagged_count} flagged for reconciliation`);
      return parts.join(" · ");
    }
  }
}

type RpcResult<T> = Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = <T,>(name: string, args: Record<string, unknown>): RpcResult<T> =>
  (supabase as unknown as { rpc: (n: string, a: Record<string, unknown>) => RpcResult<T> }).rpc(name, args);

export async function startInboundSync(organizationId: string): Promise<{ jobId: string; deduplicated: boolean }> {
  const { data, error } = await supabase.functions.invoke("pwt-inbound", { body: { action: "start", organization_id: organizationId } });
  if (error) throw new Error(error.message || "Unable to start Sync from Tally");
  const p = data as { accepted?: boolean; job_id?: string; deduplicated?: boolean; error?: string } | null;
  if (!p?.accepted || !p.job_id) throw new Error(p?.error ?? "Unable to start Sync from Tally");
  return { jobId: p.job_id, deduplicated: p.deduplicated === true };
}

export async function listInboundJobs(organizationId: string, limit = 10): Promise<PwtInboundJob[]> {
  const { data, error } = await rpc<PwtInboundJob[]>("pwt_inbound_list_jobs_v1", { p_organization_id: organizationId, p_limit: limit });
  if (error) throw new Error(error.message);
  return (data ?? []).map((j) => ({ ...j, imported_amount: Number(j.imported_amount) }));
}

export async function getInboundProblems(organizationId: string, jobId: string): Promise<PwtInboundProblem[]> {
  const { data, error } = await rpc<PwtInboundProblem[]>("pwt_inbound_job_problems_v1", { p_organization_id: organizationId, p_job_id: jobId });
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({ ...p, amount: Number(p.amount) }));
}

/** The most recent job that finished without failing (the "last successful synchronization"). */
export function lastSuccessful(jobs: PwtInboundJob[]): PwtInboundJob | undefined {
  return jobs.find((j) => (j.status === "completed" || j.status === "needs_attention") && j.completed_at);
}

/** The exact Tally voucher type that carries employee payments (organisation setting; default "PesoWise Payment"). */
export async function getInboundVoucherType(organizationId: string): Promise<string> {
  const { data, error } = await rpc<{ voucher_type: string }>("pwt_inbound_get_settings_v1", { p_organization_id: organizationId });
  if (error) throw new Error(error.message);
  return data?.voucher_type ?? "PesoWise Payment";
}

export async function setInboundVoucherType(organizationId: string, voucherType: string): Promise<void> {
  const name = voucherType.trim();
  if (!name) throw new Error("Enter the exact voucher type name used in TallyPrime.");
  const { error } = await rpc("pwt_inbound_set_voucher_type_v1", { p_organization_id: organizationId, p_voucher_type: name });
  if (error) throw new Error(error.message);
}
