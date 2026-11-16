# Phase 5 — Metadata ledger architecture (production mapping)

**Status (2026-10-06):**

| Area | Status |
|------|--------|
| **Metadata persistence mechanism (real Tally 7.1)** | **PASS** — manual + HTTP ledger create |
| **Production serializer / mapping** | **IMPLEMENTED** — automated unit tests **PASS** |
| **Connector end-to-end delivery** | **NOT YET VALIDATED** |
| **Phase 6** | **NOT STARTED** |

---

## Rejected: metadata Journal voucher

**PesoWise Report Meta** (Journal) cannot be used as an empty metadata container in TallyPrime 7.x:

- Controlled imports: `CREATED=0`, `EXCEPTIONS=1` for metadata-only voucher XML.
- Manual UI: ledger grid required; **Allow zero-valued transactions ≠ zero lines**.
- Balanced ±₹1 test created real **Payment** vouchers with **no persisted UDF** — **prohibited**.

## Accepted: metadata ledger

| Item | Value |
|------|--------|
| Group | **PesoWise Metadata** (bootstrap `GROUP` under **Primary** when metadata commands present) |
| Master | One **Ledger** per `reportMetadataDeliveryKey` |
| Name | **`PW-META-{sha256(delivery_key).slice(0,12)}`** |
| UDF | **`PESOWISE_METADATA_JSON`**, index **25001** |
| Import report | **`All Masters`** |
| Accounting | **None** — no opening balance, not used on voucher lines |

### Validated XML shape (minimum import)

```xml
<TALLYMESSAGE xmlns:UDF="TallyUDF">
  <LEDGER ACTION="Create|Alter">
    <NAME.LIST><NAME>PW-META-…</NAME></NAME.LIST>
    <PARENT>PesoWise Metadata</PARENT>
    <UDF:PESOWISE_STABLE_KEY TYPE="String">…delivery_key…</UDF:PESOWISE_STABLE_KEY>
    <UDF:PESOWISE_METADATA_JSON.LIST DESC="`PESOWISE_METADATA_JSON`" ISLIST="YES" TYPE="String" INDEX="25001">
      <UDF:PESOWISE_METADATA_JSON DESC="`PESOWISE_METADATA_JSON`">…escaped JSON…</UDF:PESOWISE_METADATA_JSON>
    </UDF:PESOWISE_METADATA_JSON.LIST>
  </LEDGER>
</TALLYMESSAGE>
```

Real Tally evidence: **PW-META-MANUAL-001** (manual), **PW-META-HTTP-001** (HTTP).

---

## Separation: report metadata vs accounting

| Class | Tally object |
|-------|----------------|
| **Report read-model** | Metadata **ledger** + JSON UDF |
| **Accounting** | **PesoWise Expense** / **PesoWise Balance** vouchers only |

Cross-report expense dedupe unchanged: **one** expense voucher per `{org}:acct:expense:{id}`; **up to four** metadata ledgers (CV, CA, Detailed, Daily) may reference the same expense via JSON `accounting_key`.

---

## CREATE / SKIP / changed content

Uses `decideDelivery` on **K** = `reportMetadataDeliveryKey`:

| Decision | Production XML |
|----------|----------------|
| **create** | `LEDGER ACTION="Create"` → `PW-META-{sha256(K)[0:12]}-{H[0:12]}` |
| **skip** | no metadata command |
| **update** (changed **H**) | **CREATE** new immutable version ledger (append-only) — **not** Tally Alter |

See **PHASE-05-METADATA-APPEND-ONLY-VERSIONS.md**. HTTP Alter abandoned for production metadata.

JSON includes **`metadata_delivery_key`** (same as delivery key).

---

## Remaining real-Tally gates

- Connector delivery of production batches (7 pending smoke jobs **not** delivered).
- Connector E2E with versioned CREATE batches.
- Optional: post-create GUID capture for ops (not required for append-only path).
- Group bootstrap on fresh companies (CREATE group under Primary).
- Full sync button E2E.

---

## Code references

- `src/lib/tallyMapping/identities.ts` — `metadataLedgerName`, group constants
- `src/lib/tallyMapping/xml/serialize.ts` — `serializeMetadataLedger`
- `src/lib/tallyMapping/mapPreparedItem.ts` — metadata ledger commands
- `src/lib/tallyMapping/pipeline.ts` — group bootstrap
- Mirror: `supabase/functions/_shared/tallyMapping/`
