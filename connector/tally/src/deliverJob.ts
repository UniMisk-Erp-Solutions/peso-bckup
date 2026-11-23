import { isMetadataImportReady, type ConnectorConfig } from "./config.js";
import { log } from "./logger.js";
import { PesoConnectorApi } from "./pesoApi.js";
import { TallyClient } from "./tallyClient.js";
import { deliverBoundBatch } from "./deliverBatch.js";
import { checkTcpPort, DOCTOR_TALLY_TCP_TIMEOUT_MS } from "./tallyTcpCheck.js";

const MAX_BATCHES_PER_JOB = 10_000;
const WAIT_BATCHES_MS = 2000;
const WAIT_BATCHES_ATTEMPTS = 120;

export type DeliverJobResult = {
  job_id: string;
  batches_attempted: number;
  batches_succeeded: number;
  batches_failed: number;
  stopped_reason: "complete" | "tally_offline" | "company_unverified" | "metadata_unverified" | "no_batches_timeout" | "partial_failure";
};

export async function deliverEntireJob(
  cfg: ConnectorConfig,
  jobId: string,
  agentVersion: string,
): Promise<DeliverJobResult> {
  if (!cfg.deviceToken) throw new Error("deviceToken missing — pair first");
  if (!isMetadataImportReady(cfg, agentVersion)) {
    return {
      job_id: jobId,
      batches_attempted: 0,
      batches_succeeded: 0,
      batches_failed: 0,
      stopped_reason: "metadata_unverified",
    };
  }
  const peso = new PesoConnectorApi(cfg.pesoApiUrl, cfg.deviceToken);
  const tally = new TallyClient({
    host: cfg.tallyHost,
    port: cfg.tallyPort,
    companyName: cfg.tallyCompanyName,
  });

  const companyCheck = await tally.verifyActiveCompany(cfg.tallyCompanyName ?? "");
  if (!companyCheck.verified) {
    return {
      job_id: jobId,
      batches_attempted: 0,
      batches_succeeded: 0,
      batches_failed: 0,
      stopped_reason: "company_unverified",
    };
  }

  await peso.heartbeat(agentVersion);

  const tcpOk = await checkTcpPort(cfg.tallyHost ?? "127.0.0.1", cfg.tallyPort ?? 9000, DOCTOR_TALLY_TCP_TIMEOUT_MS);
  if (!tcpOk) {
    return {
      job_id: jobId,
      batches_attempted: 0,
      batches_succeeded: 0,
      batches_failed: 0,
      stopped_reason: "tally_offline",
    };
  }

  let batchesAttempted = 0;
  let batchesSucceeded = 0;
  let batchesFailed = 0;

  for (let attempt = 0; attempt < WAIT_BATCHES_ATTEMPTS; attempt++) {
    const plan = await peso.jobBatches(jobId);
    if (plan.batches.length === 0) {
      await sleep(WAIT_BATCHES_MS);
      continue;
    }
    // A failed or manually held batch means the job needs reconciliation.
    // Never skip over it and import later batches from the same report.
    if (plan.batches.some((b) => ["manual_review", "failed", "quarantined"].includes(b.status))) {
      batchesFailed += 1;
      break;
    }
    const pending = plan.batches
      .filter((b) => b.status === "pending")
      .sort((a, b) => a.batch_index - b.batch_index);
    const claimed = plan.batches.filter((b) => b.status === "claimed").length;
    if (pending.length === 0) {
      if (claimed > 0) {
        await sleep(WAIT_BATCHES_MS);
        continue;
      }
      break;
    }

    let stopAfterFailure = false;
    for (const b of pending) {
      if (batchesAttempted >= MAX_BATCHES_PER_JOB) break;
      log(`Deliver job=${jobId} batch=${b.id} idx=${b.batch_index}`);
      const r = await deliverBoundBatch(cfg, peso, tally, jobId, b.id);
      if (r.error_safe === "claim_refused") {
        log(`Stop job=${jobId} batch=${b.id} (claim refused; preserving batch for reconciliation)`);
        // Fail closed. A job-scoped delivery request must not keep probing a
        // batch after the server rejects its claim; the batch remains untouched
        // for a deliberate later reconciliation or sync attempt.
        batchesFailed += 1;
        stopAfterFailure = true;
        break;
      }
      batchesAttempted += 1;
      if (r.success) batchesSucceeded += 1;
      else {
        batchesFailed += 1;
        stopAfterFailure = true;
        break;
      }
    }
    if (stopAfterFailure) break;
    if (stopAfterFailure) break;
    // Keep draining pending batches; job-level failure is decided server-side after all batches are acked.
  }

  const finalPlan = await peso.jobBatches(jobId);
  const stillPending = finalPlan.batches.some((b) => b.status === "pending");
  if (finalPlan.batches.length === 0) {
    return {
      job_id: jobId,
      batches_attempted: batchesAttempted,
      batches_succeeded: batchesSucceeded,
      batches_failed: batchesFailed,
      stopped_reason: "no_batches_timeout",
    };
  }

  return {
    job_id: jobId,
    batches_attempted: batchesAttempted,
    batches_succeeded: batchesSucceeded,
    batches_failed: batchesFailed,
    stopped_reason: stillPending ? "partial_failure" : "complete",
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
