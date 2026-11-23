# Metadata revision model

## Problem

SHA-256 `content_hash` strings must **not** be ordered lexicographically to pick the “current” metadata row. That ordering has no time meaning.

## Semantics

For logical key **K** (`metadata_delivery_key`):

| Event | Revision | Tally action |
|-------|----------|--------------|
| First **H1** | 1 | CREATE physical ledger |
| Same **H1** | 1 | SKIP (no XML) |
| New **H2** | 2 | CREATE new physical ledger |
| Retry **H2** | 2 | SKIP |
| New **H3** | 3 | CREATE … |

JSON payload fields (required): `metadata_delivery_key`, `content_hash`, `metadata_revision`, `report_type`, `source_key`, `organization_id`, …

TDL (future): current row = **highest `metadata_revision`** for each **K**.

## Application layer

- `expectedMetadataRevision()` / `nextMetadataRevision()` in `src/lib/tallyMapping/metadataRevision.ts`
- Set on map in `mapPreparedItem.ts`
- Batches carry `delivery_updates[]` with `metadata_revision` for ACK

## Database

Migration `20261007150000_tally_metadata_revision.sql`:

- Column `tally_delivery_state.last_metadata_revision`
- Column `tally_sync_delivery_batches.delivery_updates`
- Function `tally_expected_metadata_revision_v1(last_hash, last_rev, new_hash)`
- ACK path: `SELECT … FOR UPDATE` on delivery row; on revision mismatch → batch back to **`pending`**, error `metadata_revision_mismatch` (remap on retry)

## Migration / deploy

Apply migration on backup Supabase **before** relying on revision in production ACK. Until applied, server may ignore `last_metadata_revision` on load (mapper still emits correct JSON).

## Legacy rows

Rows without `last_metadata_revision`: first change after deploy treats missing as **1** and allocates **2** for new hash (same as `(last_metadata_revision ?? 1) + 1`).
