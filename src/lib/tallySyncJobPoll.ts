import { supabase } from "@/integrations/supabase/client";

export type TallySyncJobRow = {
  id: string;
  status: string;
  prepared_item_count: number | null;
  error_message_safe: string | null;
};

export type TallyBatchSummary = {
  pending: number;
  claimed: number;
  delivered: number;
  failed: number;
  manual_review: number;
  skipped: number;
  total: number;
  /** Sum of Tally CREATED from batch ack_summary (0 = duplicates only — report may stay empty). */
  tally_masters_created: number;
  tally_masters_altered: number;
  /** Delivered batches where Tally returned duplicate-only without UDF refresh. */
  tally_udf_refresh_unconfirmed: number;
  /** Report metadata ledgers confirmed by a post-import read-only Tally Export. */
  tally_readback_verified_batches?: number;
  tally_readback_unverified_batches?: number;
  tally_readback_expected?: number;
  tally_readback_found?: number;
};

export async function fetchTallySyncJob(jobId: string): Promise<TallySyncJobRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("tally_sync_jobs")
    .select("id, status, prepared_item_count, error_message_safe")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as TallySyncJobRow | null;
}

/** Most recent sync job for this org + report tab (survives page reload). */
export async function fetchLatestTallySyncJob(
  organizationId: string,
  reportType: string,
): Promise<TallySyncJobRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("tally_sync_jobs")
    .select("id, status, prepared_item_count, error_message_safe")
    .eq("organization_id", organizationId)
    .eq("report_type", reportType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as TallySyncJobRow | null;
}

export function isActiveTallySyncStatus(status: string | null | undefined): boolean {
  return (
    status === "queued" ||
    status === "processing" ||
    status === "prepared" ||
    status === "waiting_for_connector" ||
    status === "delivering"
  );
}

export async function fetchTallyBatchSummary(jobId: string): Promise<TallyBatchSummary> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("tally_sync_delivery_batches")
    .select("status, ack_summary")
    .eq("job_id", jobId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as {
    status: string;
    ack_summary?: {
      created?: number;
      altered?: number;
      duplicate_only?: boolean;
      udf_refresh_confirmed?: boolean;
      readback_verified?: boolean;
      readback_expected?: number;
      readback_found?: number;
    } | null;
  }[];
  const summary: TallyBatchSummary = {
    pending: 0,
    claimed: 0,
    delivered: 0,
    failed: 0,
    manual_review: 0,
    skipped: 0,
    total: rows.length,
    tally_masters_created: 0,
    tally_masters_altered: 0,
    tally_udf_refresh_unconfirmed: 0,
    tally_readback_verified_batches: 0,
    tally_readback_unverified_batches: 0,
    tally_readback_expected: 0,
    tally_readback_found: 0,
  };
  for (const r of rows) {
    const s = r.status as keyof Omit<
      TallyBatchSummary,
      "total" | "tally_masters_created" | "tally_masters_altered" | "tally_udf_refresh_unconfirmed"
    >;
    if (s in summary) summary[s] += 1;
    const ack = r.ack_summary;
    if (ack && typeof ack === "object") {
      summary.tally_masters_created += Number(ack.created ?? 0) || 0;
      summary.tally_masters_altered += Number(ack.altered ?? 0) || 0;
      const dup = ack.duplicate_only === true;
      const udfOk =
        ack.udf_refresh_confirmed === true ||
        (Number(ack.created ?? 0) || 0) + (Number(ack.altered ?? 0) || 0) > 0;
      if (r.status === "delivered" && dup && !udfOk) summary.tally_udf_refresh_unconfirmed += 1;
      const readbackExpected = Math.max(0, Number(ack.readback_expected ?? 0) || 0);
      if (r.status === "delivered" && readbackExpected > 0) {
        const readbackFound = Math.max(0, Number(ack.readback_found ?? 0) || 0);
        summary.tally_readback_expected! += readbackExpected;
        summary.tally_readback_found! += readbackFound;
        if (ack.readback_verified === true && readbackFound === readbackExpected) {
          summary.tally_readback_verified_batches! += 1;
        } else {
          summary.tally_readback_unverified_batches! += 1;
        }
      }
    }
  }
  return summary;
}

export function tallyImportConfirmedInTally(
  job: TallySyncJobRow | null,
  batches: TallyBatchSummary | null,
): boolean {
  const prepared = job?.prepared_item_count ?? 0;
  if (prepared <= 0) return true;
  if (!batches) return false;
  const deliverable = tallyDeliverableBatchCount(batches);
  if (deliverable === 0 && batches.total > 0) return false;
  if (batches.tally_udf_refresh_unconfirmed > 0) return false;
  return batches.tally_masters_created + batches.tally_masters_altered > 0;
}

/** When sync finished but Tally did not accept or confirm metadata. */
export function describeTallyImportNotConfirmed(
  job: TallySyncJobRow | null,
  batches: TallyBatchSummary | null,
): string {
  const prepared = job?.prepared_item_count ?? 0;
  if (
    batches &&
    batches.total > 0 &&
    batches.skipped === batches.total &&
    prepared > 0 &&
    batches.failed === 0 &&
    batches.manual_review === 0
  ) {
    return `No new data was sent to Tally: all ${prepared.toLocaleString()} prepared rows match content already recorded as synchronized for this organization. Tally receives only new or changed rows.`;
  }
  if (batches && batches.tally_udf_refresh_unconfirmed > 0) {
    return "Tally reported duplicate records without confirming the report fields. Reconcile this batch in Admin → Tally integration before taking further action.";
  }
  if (
    batches &&
    tallyDeliverableBatchCount(batches) > 0 &&
    batches.delivered >= tallyDeliverableBatchCount(batches) &&
    batches.tally_masters_created + batches.tally_masters_altered === 0
  ) {
    return "Tally returned no created or altered records. Reconcile the batch against the intended company before any retry.";
  }
  if (!batches && prepared > 0) {
    return "Sync finished but delivery details are unavailable. Check Admin → Tally integration before starting another job.";
  }
  return "Tally did not confirm the import. Reconcile the batch against Tally before authorizing a retry.";
}

/** Batches that actually carry XML to Tally (empty chunk slots are `skipped`). */
export function tallyDeliverableBatchCount(batches: TallyBatchSummary): number {
  return Math.max(0, batches.total - batches.skipped);
}

export function isTallyDeliveryComplete(
  job: TallySyncJobRow | null,
  batches: TallyBatchSummary | null,
): boolean {
  if (!batches || batches.total === 0) {
    return job?.status === "completed" && (job.prepared_item_count ?? 0) === 0;
  }
  if (batches.failed > 0 || batches.manual_review > 0) return false;
  const need = tallyDeliverableBatchCount(batches);
  if (need === 0) {
    return (
      (job?.status === "completed" || job?.status === "waiting_for_connector") &&
      batches.pending === 0 &&
      batches.claimed === 0
    );
  }
  return (
    batches.delivered >= need &&
    batches.pending === 0 &&
    batches.claimed === 0 &&
    batches.failed === 0 &&
    batches.manual_review === 0
  );
}

/** User-facing status for Reports → Sync to Tally. */
export function describeTallySyncProgress(
  job: TallySyncJobRow | null,
  batches: TallyBatchSummary | null,
): string {
  if (!job) return "Sync job not found.";
  if (job.status === "cancelled") {
    return job.error_message_safe?.trim() || "This report sync was cancelled before delivery. No Tally import was sent.";
  }
  if (job.status === "failed") {
    const msg = job.error_message_safe?.trim() || "Tally sync preparation failed.";
    if (/delivery batch/i.test(msg)) {
      return `${msg} — reconcile the batch in Admin → Tally integration before authorizing any retry.`;
    }
    return msg;
  }
  if (job.status === "queued" || job.status === "processing") {
    return `Preparing data on server… (${job.status})`;
  }
  if (job.status === "completed" && (job.prepared_item_count ?? 0) === 0) {
    return "Preparation completed with 0 rows. No Tally import was sent.";
  }
  if (job.status === "prepared") {
    const n = job.prepared_item_count ?? 0;
    if (batches && batches.total > 0) {
      return `Building Tally delivery batches… ${batches.total} batch(es) queued so far (${n.toLocaleString()} rows). Leave this page open…`;
    }
    if (n > 3000) {
      return `Prepared — building Tally delivery batches for ${n.toLocaleString()} rows (large jobs can take 5–20 min). Leave this page open…`;
    }
    return "Prepared — building Tally delivery batches…";
  }
  if (batches && batches.total > 0) {
    const need = tallyDeliverableBatchCount(batches);
    if (isTallyDeliveryComplete(job, batches)) {
      if (!tallyImportConfirmedInTally(job, batches)) {
        return describeTallyImportNotConfirmed(job, batches);
      }
      if ((batches.tally_readback_expected ?? 0) > 0
        && (batches.tally_readback_unverified_batches ?? 0) === 0
        && batches.tally_readback_found === batches.tally_readback_expected) {
        return `Tally import and read-back verified (${batches.tally_readback_found} report rows; ${batches.tally_masters_created} created, ${batches.tally_masters_altered} altered).`;
      }
      return `Tally returned a clean import response (${batches.tally_masters_created} created, ${batches.tally_masters_altered} altered). The report records have not been verified by read-back.`;
    }
    if (batches.failed > 0 || batches.manual_review > 0) {
      return `Delivery issue: ${batches.delivered} delivered, ${batches.failed} failed, ${batches.manual_review} need manual review.`;
    }
    if (batches.pending > 0 || batches.claimed > 0) {
      const claimedNote =
        batches.claimed > 0 && batches.delivered === 0 ? ` (${batches.claimed} in progress)` : "";
      const denom = need > 0 ? need : batches.total;
      return `Delivering to Tally on this PC (${batches.delivered}/${denom} batches${claimedNote})…`;
    }
  }
  if (job.status === "waiting_for_connector") {
      return batches?.delivered
        ? `${batches.delivered} batch(es) are recorded delivered. Remaining delivery is paused until the active Tally company is verified.`
        : "Prepared and queued. Delivery is paused until the connector can verify the active Tally company; no import has been sent.";
  }
  if (job.status === "delivering") {
    return "Delivering to Tally…";
  }
  if (job.status === "completed") {
    if (batches && batches.failed > 0) {
      return "TallyPrime is unavailable or rejected import. Open the company in TallyPrime, enable TallyPrime Server for this company, then Sync again.";
    }
    if (!tallyImportConfirmedInTally(job, batches)) {
      return describeTallyImportNotConfirmed(job, batches);
    }
    return `Tally returned a clean import response (${batches?.tally_masters_created ?? 0} created, ${batches?.tally_masters_altered ?? 0} altered). The report records have not been verified by read-back.`;
  }
  return `Status: ${job.status}`;
}
