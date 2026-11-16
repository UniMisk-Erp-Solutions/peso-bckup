import { isMetadataImportReady, type ConnectorConfig } from "./config.js";
import { AGENT_VERSION } from "./doctor.js";
import { log } from "./logger.js";
import { PesoConnectorApi, type ClaimResult } from "./pesoApi.js";
import { TallyClient } from "./tallyClient.js";
import { metadataReportTypeFromDeliveryKey } from "./metadataReadback.js";

export function injectTallyCompany(xml: string, company: string): string {
  const name = company.trim();
  if (!name) throw new Error("Tally company is not configured");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Tally XML declarations are not permitted");
  const envelopeOpen = [...xml.matchAll(/<ENVELOPE\b[^>]*>/gi)];
  const envelopeClose = [...xml.matchAll(/<\/ENVELOPE\s*>/gi)];
  if (envelopeOpen.length !== 1 || envelopeClose.length !== 1 || envelopeOpen[0].index! > envelopeClose[0].index!) {
    throw new Error("Tally XML envelope is missing or malformed");
  }
  const tags = [...xml.matchAll(/<SVCURRENTCOMPANY\b[^>]*>([\s\S]*?)<\/SVCURRENTCOMPANY>/gi)];
  if (tags.length !== 1) throw new Error("Tally XML must contain exactly one company field");
  const current = tags[0][1].trim();
  const escapeXmlText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const field = tags[0][0];
  if (current === "<!-- configured at connector time -->") {
    return xml.replace(field, `<SVCURRENTCOMPANY>${escapeXmlText(name)}</SVCURRENTCOMPANY>`);
  }
  if (current !== escapeXmlText(name) && current !== name) {
    throw new Error("Tally XML company does not match the configured company");
  }
  return xml;
}

/** Active-company fallback is prohibited because it can direct data to another company. */
export function useTallyActiveCompany(xml: string): string {
  void xml;
  throw new Error("Using the active Tally company is disabled; company identity is unverified");
}

export type DeliverBatchResult = {
  batch_id: string;
  success: boolean;
  skipped_empty?: boolean;
  error_safe?: string;
};

type ClaimedBatch = Extract<ClaimResult, { claimed: true }>;

/** Deliver once, only after a live read-only active-company check matches the intended company. */
export async function deliverClaimedBatch(
  cfg: ConnectorConfig,
  peso: PesoConnectorApi,
  tally: TallyClient,
  claim: ClaimedBatch,
): Promise<DeliverBatchResult> {
  const batchId = claim.batch_id;
  if (claim.message_count === 0) {
    await peso.ack({ batch_id: batchId, success: true, ack_summary: { skipped_empty: true } });
    return { batch_id: batchId, success: true, skipped_empty: true };
  }

  const configuredCompany = cfg.tallyCompanyName?.trim();
  const backendCompany = claim.tally_company_name?.trim();
  let errorSafe: string | null = null;
  let tallyResponseSafe: string | undefined;
  if (!configuredCompany || !backendCompany || configuredCompany !== backendCompany) {
    errorSafe = "Tally company configuration mismatch or missing";
  } else {
    try {
      // Validate the frozen XML's target without posting it.
      const xml = injectTallyCompany(claim.xml, configuredCompany);
      const companyCheck = await tally.verifyActiveCompany(configuredCompany);
      if ("reason" in companyCheck) {
        errorSafe = `Active Tally company is not verified (${companyCheck.reason}); reconcile before retry`;
      } else if (companyCheck.companyName !== configuredCompany) {
        errorSafe = "Active Tally company identity mismatch; reconcile before retry";
      } else {
        const response = await tally.postImportXmlOnce(xml);
        tallyResponseSafe = response.text.slice(0, 4000);
        if (!response.httpOk || !response.parsed.ok) {
          errorSafe = response.parsed.errors.join("; ").slice(0, 500)
            || `Tally import outcome was not a complete clean success (HTTP ${response.httpOk ? "ok" : "error"}); reconcile before retry`;
        } else {
          const metadataUpdates = (claim.delivery_updates ?? []).filter((update) => {
            return typeof update === "object" && update !== null
              && (update as { delivery_kind?: unknown }).delivery_kind === "report_metadata";
          }) as { delivery_key?: string; tally_remote_id?: string | null }[];
          const readbackAck: Record<string, unknown> = {};
          if (metadataUpdates.length > 0) {
            const reportTypes = metadataUpdates.map((update) =>
              update.delivery_key ? metadataReportTypeFromDeliveryKey(update.delivery_key) : null,
            );
            const expectedLedgerNames = metadataUpdates
              .map((update) => String(update.tally_remote_id ?? "").trim())
              .filter(Boolean);
            const reportType = reportTypes[0];
            if (!reportType || reportTypes.some((type) => type !== reportType)
              || expectedLedgerNames.length !== metadataUpdates.length) {
              errorSafe = "Tally accepted the import, but the batch read-back plan was invalid; reconcile before retry";
            } else {
              // Recheck the active company immediately before the read-only Export.
              const readbackCompany = await tally.verifyActiveCompany(configuredCompany);
              if (!readbackCompany.verified || readbackCompany.companyName !== configuredCompany) {
                errorSafe = "Tally accepted the import, but the active company could not be re-verified for read-back; reconcile before retry";
              } else {
                const readback = await tally.verifyMetadataReadback(reportType, expectedLedgerNames);
                if (!readback.verified) {
                  errorSafe = `Tally accepted the import, but read-back found ${readback.found} of ${readback.expected} expected report rows; reconcile before retry`;
                } else {
                  readbackAck.readback_verified = true;
                  readbackAck.readback_expected = readback.expected;
                  readbackAck.readback_found = readback.found;
                  readbackAck.readback_report_type = reportType;
                }
              }
            }
          }
          if (!errorSafe) {
            await peso.ack({
              batch_id: batchId,
              success: true,
              tally_response_safe: tallyResponseSafe,
              ack_summary: {
                created: response.parsed.created,
                altered: response.parsed.altered,
                deleted: response.parsed.deleted,
                ignored: response.parsed.ignored,
                exceptions: response.parsed.exceptions,
                errors: response.parsed.errors,
                last_vch_id: response.parsed.lastVchId,
                last_mid: response.parsed.lastMid,
                ...readbackAck,
              },
              delivery_updates: claim.delivery_updates ?? [],
            });
            log(`Delivered and read-back verified batch=${batchId} company=${configuredCompany}`);
            return { batch_id: batchId, success: true };
          }
        }
      }
    } catch (error) {
      errorSafe = `${(error as Error).message.slice(0, 350)}; delivery outcome may be unknown, reconcile before retry`;
    }
  }

  // An unsuccessful ack is quarantined by the database; it cannot silently requeue the batch.
  const safeError = errorSafe ?? "Delivery outcome unknown; reconcile before retry";
  log(`Delivery blocked batch=${batchId}: ${safeError}`);
  await peso.ack({ batch_id: batchId, success: false, error_safe: safeError, tally_response_safe: tallyResponseSafe });
  return { batch_id: batchId, success: false, error_safe: safeError };
}

/** Bound/manual delivery checks identity before claim, then rechecks immediately before import. */
export async function deliverBoundBatch(
  cfg: ConnectorConfig,
  peso: PesoConnectorApi,
  tally: TallyClient,
  jobId: string,
  batchId: string,
): Promise<DeliverBatchResult> {
  void jobId;
  if (!isMetadataImportReady(cfg, AGENT_VERSION)) {
    return { batch_id: batchId, success: false, error_safe: "Tally metadata setup is unverified; confirm the Bootstrap/Load TDL and PesoWise Metadata group before delivery" };
  }
  if (!cfg.tallyCompanyName?.trim()) throw new Error("Tally company is not configured");
  const companyName = cfg.tallyCompanyName.trim();
  const companyCheck = await tally.verifyActiveCompany(companyName);
  if ("reason" in companyCheck) {
    log(`Bound delivery blocked batch=${batchId}: ${companyCheck.reason}`);
    return { batch_id: batchId, success: false, error_safe: companyCheck.reason };
  }
  if (companyCheck.companyName !== companyName) {
    return { batch_id: batchId, success: false, error_safe: "Active Tally company identity mismatch" };
  }
  const claim = await peso.claimBound(jobId, batchId, companyName);
  if (!claim.claimed) return { batch_id: batchId, success: false, error_safe: "claim_refused" };
  return deliverClaimedBatch(cfg, peso, tally, claim);
}
