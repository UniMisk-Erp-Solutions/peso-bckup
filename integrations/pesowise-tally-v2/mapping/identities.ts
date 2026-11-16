import { sha256Utf8HexSync } from "../tallySync/contentHash.ts";

/** Organization-scoped stable keys — never collide across orgs. */

/** Tally master group for report-metadata ledger carriers (real Tally 7.1 validated). */
export const PESOWISE_METADATA_GROUP_NAME = "PesoWise Metadata";

/** UDF slot for JSON metadata on metadata ledgers (Tally export INDEX). */
export const PESOWISE_METADATA_JSON_UDF_INDEX = "25001";

export const TALLY_METADATA_XML_TRANSPORT_REV = 4;

export function tallyMetadataDeliveryHash(contentHash: string): string {
  const h = String(contentHash ?? "").trim();
  if (!h) return h;
  return `${h}@xml${TALLY_METADATA_XML_TRANSPORT_REV}`;
}

export function pesowiseMetadataGroupKey(organizationId: string): string {
  return `${organizationId}:master:group:pesowise_metadata`;
}

/** Legacy single-name ledger (Phase 5.3 Test A only — prefer versioned names). */
export function metadataLedgerName(metadataDeliveryKey: string): string {
  const digest = sha256Utf8HexSync(metadataDeliveryKey).slice(0, 12);
  return `PW-META-${digest}`.slice(0, 200);
}

/**
 * Append-only metadata version: one immutable Tally ledger per (K, H).
 * PW-META-{sha256(K)[0:12]}-{contentHash[0:12]}
 */
export function metadataVersionLedgerName(metadataDeliveryKey: string, contentHash: string): string {
  const kPart = sha256Utf8HexSync(metadataDeliveryKey).slice(0, 12);
  const hPart = contentHash.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 12);
  return `PW-META-${kPart}-${hPart}`.slice(0, 200);
}

/** Per-version delivery idempotency key (same K+H → same physical ledger). */
export function metadataVersionDeliveryKey(metadataDeliveryKey: string, contentHash: string): string {
  return `${metadataDeliveryKey}:content:${contentHash}`;
}

/** Tally master GUID from ledger export (Alter import identity on TallyPrime 7.1). */
export function isTallyMasterGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]+$/i.test(
    value.trim(),
  );
}

export function accountingExpenseKey(organizationId: string, expenseId: string): string {
  return `${organizationId}:acct:expense:${expenseId}`;
}

export function accountingBalanceEventKey(organizationId: string, eventId: string): string {
  return `${organizationId}:acct:balance_event:${eventId}`;
}

export function reportMetadataDeliveryKey(
  organizationId: string,
  reportType: string,
  sourceKey: string,
): string {
  return `${organizationId}:meta:${reportType}:${sourceKey}`;
}

export function employeeLedgerKey(organizationId: string, userId: string): string {
  return `${organizationId}:master:employee:${userId}`;
}

export function categoryLedgerKey(organizationId: string, categorySlug: string): string {
  return `${organizationId}:master:category:${categorySlug}`;
}

export function projectCostCentreKey(organizationId: string, projectId: string): string {
  return `${organizationId}:master:project:${projectId}`;
}

export function slugifyCategory(category: string): string {
  const t = category.trim().toLowerCase();
  if (!t) return "_uncategorized";
  return t.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "_uncategorized";
}

export function deterministicLedgerName(prefix: string, stableId: string, display: string): string {
  const safe = display.trim() || "Unknown";
  return `${prefix} ${stableId.slice(0, 8)} — ${safe}`.slice(0, 200);
}
