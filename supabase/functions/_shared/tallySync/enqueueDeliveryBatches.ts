import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deliveryBatchSizeForReport } from "./deliveryBatchSize.ts";
import { AccountingRegistry } from "../tallyMapping/accountingRegistry.ts";
import {
  isE2eControlledSingleMetadataParameters,
  mapPreparedJobItemsControlledE2e,
} from "../tallyMapping/controlledE2e.ts";
import { mapPreparedJobItems } from "../tallyMapping/pipeline.ts";
import { isPresentationOnlyJob, syncRunIdFromJob } from "../tallyMapping/presentationOnly.ts";
import type { DeliveryStateRow, MapJobOptions, PreparedJobItem } from "../tallyMapping/types.ts";

const ITEMS_PER_CHUNK = 500;
const MONOLITHIC_MAX_ITEMS = 800;

export type EnqueueDeliveryResult = {
  job_id: string;
  batches: number;
  batch_total: number;
  accounting_vouchers: number;
  job_status: string | null;
  e2e_controlled_single_metadata: boolean;
  chunked: boolean;
  more_chunks: boolean;
};

async function dispatchDeliveryContinuation(jobId: string): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  fetch(`${url}/functions/v1/run-tally-sync-delivery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch((e) => console.error("run-tally-sync-delivery continuation:", e));
}

function readChunkCursor(parameters: unknown): { afterSeq: number; registry: AccountingRegistry } {
  const p = parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>) : {};
  const afterSeq = typeof p._tally_delivery_after_seq === "number"
    ? p._tally_delivery_after_seq
    : Number(p._tally_delivery_after_seq ?? 0) || 0;
  return {
    afterSeq,
    registry: AccountingRegistry.fromCheckpoint(p._tally_delivery_registry),
  };
}

async function persistChunkCursor(
  svc: SupabaseClient,
  jobId: string,
  parameters: unknown,
  afterSeq: number,
  registry: AccountingRegistry,
): Promise<void> {
  const base = parameters && typeof parameters === "object"
    ? { ...(parameters as Record<string, unknown>) }
    : {};
  base._tally_delivery_after_seq = afterSeq;
  base._tally_delivery_registry = registry.toCheckpoint();
  await svc.from("tally_sync_jobs").update({ parameters: base }).eq("id", jobId);
}

/** Map prepared items → XML batches → DB queue (chunked for large jobs). */
export async function enqueueDeliveryBatches(
  svc: SupabaseClient,
  jobId: string,
): Promise<EnqueueDeliveryResult> {
  const { data: job, error: jobErr } = await svc
    .from("tally_sync_jobs")
    .select("id, organization_id, status, parameters, prepared_item_count, report_type")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr || !job) throw new Error("job not found");
  if (job.status !== "prepared" && job.status !== "waiting_for_connector") {
    throw new Error(`job status ${job.status} not enqueueable`);
  }

  const orgId = String(job.organization_id);
  const preparedCount = Number(job.prepared_item_count ?? 0);

  const { data: stateJson, error: stateErr } = await svc.rpc("load_tally_delivery_state_v1", {
    p_organization_id: orgId,
  });
  if (stateErr) throw new Error(stateErr.message);
  const delivery_state = (stateJson ?? []) as DeliveryStateRow[];

  const e2eControlled = isE2eControlledSingleMetadataParameters(job.parameters);
  const batchSize = deliveryBatchSizeForReport(String(job.report_type ?? ""));
  const mapOptsBase = (): Omit<MapJobOptions, "delivery_state"> => ({
    organization_id: orgId,
    job_id: jobId,
    batch_size: batchSize,
    presentation_only: isPresentationOnlyJob(job.parameters),
    sync_run_id: syncRunIdFromJob(job.parameters),
  });

  if (e2eControlled || preparedCount <= MONOLITHIC_MAX_ITEMS) {
    const { data: itemsJson, error: itemsErr } = await svc.rpc("load_tally_sync_job_items_v1", { p_job_id: jobId });
    if (itemsErr) throw new Error(itemsErr.message);
    const items = (itemsJson ?? []) as PreparedJobItem[];
    const mapped = e2eControlled
      ? mapPreparedJobItemsControlledE2e(items, {
          organization_id: orgId,
          job_id: jobId,
          delivery_state,
          batch_size: batchSize,
        })
      : mapPreparedJobItems(items, { ...mapOptsBase(), delivery_state });
    const batches = mapped.xml_batches.map((b) => ({
      batch_index: b.batch_index,
      message_count: b.message_count,
      xml: b.xml,
      delivery_updates: b.delivery_updates ?? [],
    }));
    const { data: stored, error: storeErr } = await svc.rpc("store_tally_delivery_batches_v1", {
      p_job_id: jobId,
      p_batches: batches,
    });
    if (storeErr) throw new Error(storeErr.message);
    const store = stored as Record<string, unknown> | null;
    return {
      job_id: jobId,
      batches: batches.length,
      batch_total: batches.length,
      accounting_vouchers: mapped.accounting_voucher_count,
      e2e_controlled_single_metadata: e2eControlled,
      job_status: typeof store?.job_status === "string" ? store.job_status : null,
      chunked: false,
      more_chunks: false,
    };
  }

  const { afterSeq, registry } = readChunkCursor(job.parameters);
  const { data: pageJson, error: pageErr } = await svc.rpc("load_tally_sync_job_items_page_v1", {
    p_job_id: jobId,
    p_after_seq: afterSeq,
    p_limit: ITEMS_PER_CHUNK,
  });
  if (pageErr) throw new Error(pageErr.message);
  const pageItems = (pageJson ?? []) as PreparedJobItem[];

  if (pageItems.length === 0) {
    const { data: fin, error: finErr } = await svc.rpc("append_tally_delivery_batches_v1", {
      p_job_id: jobId,
      p_batches: [],
      p_finalize: true,
    });
    if (finErr) throw new Error(finErr.message);
    const f = fin as Record<string, unknown>;
    return {
      job_id: jobId,
      batches: 0,
      batch_total: Number(f.batch_total ?? 0),
      accounting_vouchers: registry.totalAccountingVouchers(),
      e2e_controlled_single_metadata: false,
      job_status: typeof f.job_status === "string" ? f.job_status : null,
      chunked: true,
      more_chunks: false,
    };
  }

  const mapped = mapPreparedJobItems(
    pageItems,
    { ...mapOptsBase(), delivery_state },
    registry,
    { include_metadata_group: false },
  );

  const batches = mapped.xml_batches.map((b) => ({
    batch_index: b.batch_index,
    message_count: b.message_count,
    xml: b.xml,
    delivery_updates: b.delivery_updates ?? [],
  }));

  const maxSeq = pageItems.reduce((m, i) => Math.max(m, i.seq), afterSeq);
  const moreChunks = pageItems.length >= ITEMS_PER_CHUNK;

  const { data: appended, error: appendErr } = await svc.rpc("append_tally_delivery_batches_v1", {
    p_job_id: jobId,
    p_batches: batches,
    p_finalize: !moreChunks,
  });
  if (appendErr) throw new Error(appendErr.message);

  await persistChunkCursor(svc, jobId, job.parameters, maxSeq, registry);

  const a = appended as Record<string, unknown>;
  if (moreChunks) {
    await dispatchDeliveryContinuation(jobId);
  }

  return {
    job_id: jobId,
    batches: batches.length,
    batch_total: Number(a.batch_total ?? 0),
    accounting_vouchers: mapped.accounting_voucher_count,
    e2e_controlled_single_metadata: false,
    job_status: typeof a.job_status === "string" ? a.job_status : null,
    chunked: true,
    more_chunks: moreChunks,
  };
}
