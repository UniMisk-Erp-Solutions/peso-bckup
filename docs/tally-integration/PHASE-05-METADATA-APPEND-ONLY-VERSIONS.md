# Metadata append-only versions (production update path)

**Date:** 2026-10-06  
**Replaces:** in-place Tally `LEDGER ACTION="Alter"` for metadata (unproven on TallyPrime 7.1).

## Real Tally evidence

| Path | Result |
|------|--------|
| CREATE (All Masters + UDF 25001) | **PASS** |
| SKIP (application) | **PASS** — 0 HTTP |
| Manual Alter in Tally UI | **PASS** |
| HTTP Alter (`NAME.LIST`, GUID, …) | **FAIL** — `EXCEPTIONS=1` |

Production metadata **content changes** use **new immutable ledger masters**, not HTTP Alter.

## Logical vs physical identity

| Symbol | Meaning |
|--------|---------|
| **K** | `reportMetadataDeliveryKey(org, report_type, source_key)` |
| **H** | Prepared row `content_hash` (SHA-256 stable JSON) |
| **Physical ledger** | `metadataVersionLedgerName(K, H)` → `PW-META-{sha256(K)[0:12]}-{H[0:12]}` |

## Delivery behavior

| Condition | Action |
|-----------|--------|
| No prior state for **K** | **CREATE** version ledger for **K+H** |
| Same **K** + same **H** | **SKIP** — no XML, no HTTP |
| Same **K** + different **H** | **CREATE** new version ledger (prior version remains in Tally) |
| Retry same **K+H** after ack | **SKIP** |

`decideDelivery` still returns `update` for changed hash; mapper maps that to **`action: create`** on a **new** physical name.

## JSON (`PesowiseTallyMetadataV1`)

Required fields for TDL version selection:

- `metadata_delivery_key` = **K**
- `content_hash` = **H**
- `metadata_version_ledger_name` = physical name (matches Tally master)

## Current version for TDL (Phase 6)

For each **K**, among ledgers under **PesoWise Metadata** with matching `metadata_delivery_key` in JSON:

**Current row** = record with **maximum `metadata_revision`** (integer) for that **K**.

Do **not** use `content_hash` lexicographic order — hashes are not monotonic in time.

No wall-clock timestamp required. Historical versions remain for audit; TDL must **not** render more than one row per **K**.

## Accounting

Unchanged: metadata ledgers never carry opening balance or voucher lines. Expense vouchers remain `{org}:acct:expense:{id}`.

## Legacy

`PW-META-04fd0f3a4fa1` (Phase 5.3 Test A, unversioned name) remains historical evidence; new syncs use versioned names.

## Quarantine (smoke batches — run manually)

```powershell
$env:TALLY_VALIDATE_ADMIN_EMAIL="your-admin@email"
$env:TALLY_VALIDATE_ADMIN_PASSWORD="your-password"
# optional: $env:TALLY_VALIDATE_ANON_KEY="..."
node scripts/tally-integration/list-and-quarantine-smoke-batches.mjs
# after reviewing JSON output:
$env:QUARANTINE_CONFIRM="1"
node scripts/tally-integration/list-and-quarantine-smoke-batches.mjs
```

If RPC missing, apply migration first: `DEPLOY_SSH_PASSWORD=... node scripts/tally-integration/apply-quarantine-migration-only.mjs`
