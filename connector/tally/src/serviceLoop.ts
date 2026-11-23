import { PesoConnectorApi } from "./pesoApi.js";
import { TallyClient } from "./tallyClient.js";
import { log } from "./logger.js";
import type { ConnectorConfig } from "./config.js";
import { AGENT_VERSION } from "./doctor.js";
import { deliverClaimedBatch } from "./deliverBatch.js";
import { writeHealthSnapshot } from "./healthState.js";

const VERSION = AGENT_VERSION;

function publishHealth(
  cfg: ConnectorConfig,
  partial: {
    tally_reachable: boolean;
    last_delivery_batch_id?: string | null;
    last_delivery_ok?: boolean | null;
    last_error_safe?: string | null;
  },
) {
  writeHealthSnapshot({
    updated_at: new Date().toISOString(),
    agent_version: VERSION,
    connector_paired: Boolean(cfg.deviceToken),
    organization_id: cfg.organizationId ?? null,
    tally_reachable: partial.tally_reachable,
    tally_company_name: cfg.tallyCompanyName ?? null,
    last_delivery_batch_id: partial.last_delivery_batch_id ?? null,
    last_delivery_ok: partial.last_delivery_ok ?? null,
    last_error_safe: partial.last_error_safe ?? null,
  });
}

export async function runServiceLoop(cfg: ConnectorConfig) {
  if (!cfg.deviceToken) throw new Error("deviceToken missing — pair first");
  const peso = new PesoConnectorApi(cfg.pesoApiUrl, cfg.deviceToken);
  const tally = new TallyClient({
    host: cfg.tallyHost,
    port: cfg.tallyPort,
    companyName: cfg.tallyCompanyName,
  });

  let backoffMs = 5000;

  for (;;) {
    try {
      await peso.heartbeat(VERSION);
      const up = await tally.isReachable();
      if (!up) {
        log("Tally offline — retry later");
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 120_000);
        continue;
      }
      backoffMs = 5000;

      // Configured company name and TCP reachability do not establish the active company.
      // Keep the service healthy, but claim queued financial data only when the read-only
      // export probe reports the exact configured active company.
      const companyCheck = await tally.verifyActiveCompany(cfg.tallyCompanyName ?? "");
      if (!companyCheck.verified) {
        log(`Delivery paused: ${companyCheck.reason}; no delivery batches will be claimed`);
        publishHealth(cfg, { tally_reachable: true, last_error_safe: companyCheck.reason });
        await sleep(10_000);
        continue;
      }

      const claim = await peso.claim(cfg.tallyCompanyName ?? "");
      if (!claim.claimed) {
        await sleep(10_000);
        continue;
      }

      log(`Delivering batch ${claim.batch_id} job=${claim.job_id} idx=${claim.batch_index}`);
      const result = await deliverClaimedBatch(cfg, peso, tally, claim);
      if (!result.success && !result.skipped_empty) {
        log(`Batch ${claim.batch_id} delivery failed: ${result.error_safe ?? "unknown"}`);
      }
    } catch (e) {
      log(`Loop error: ${(e as Error).message}`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 120_000);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
