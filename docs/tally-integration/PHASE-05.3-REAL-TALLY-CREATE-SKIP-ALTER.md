# Phase 5.3 — Real Tally CREATE → SKIP → ALTER (production serializer)

**Company:** PesoWise Integration Test · **TallyPrime:** 7.1

| Gate | Status |
|------|--------|
| **Test A — CREATE** | **REAL TALLY PASS** — `PW-META-04fd0f3a4fa1`, `CREATED=1` |
| **Test B — SKIP** | **APPLICATION PASS** — 0 HTTP |
| **Test C — ALTER** | **REAL TALLY NOT PASS** — see below |
| Manual persistence (CREATE) | **PASS** |
| Manual persistence (post manual UDF edit) | **PASS** — `phase53-manual-alter-proof` |

---

## Exported ledger identity (real Tally evidence)

| Field | Value |
|-------|--------|
| Ledger name | `PW-META-04fd0f3a4fa1` |
| Parent | PesoWise Metadata |
| **GUID** | `ff2a6be2-de9a-4019-933a-e47a348056e3-000000e9` |
| UDF | `PESOWISE_METADATA_JSON` index **25001** |

PesoWise stable key unchanged: `reportMetadataDeliveryKey` for Phase 5.3 daily row (see Test A doc).

---

## Root cause of ALTER failures (evidence-based)

1. **Earlier attempts** used **`NAME.LIST` only** (with/without `PARENT` / `PESOWISE_STABLE_KEY`) → `EXCEPTIONS=1`.
2. **`tally_delivery_state.tally_remote_id`** held **ledger name**, not Tally **GUID** — Alter could not target the resolved master instance Tally uses internally.
3. **2026-10-06 fix:** Production mapper reads **`tally_remote_id`**; when value matches **`isTallyMasterGuid()`**, serializer emits **`<GUID>…</GUID>`** (no `NAME.LIST`) + UDF `.LIST` update.
4. **Controlled Test C (one HTTP, GUID from export):** still **`CREATED=0`, `ALTERED=0`, `EXCEPTIONS=1`** (~325 ms). Tally remained up; **no duplicate ledger**.

**Conclusion:** GUID-only Alter is **necessary but not sufficient** with current UDF envelope. **Missing repo evidence:** full single-ledger **export XML** after manual Alter showing required import fields (`MASTERID`, `NAME` attribute, `LANGUAGENAME.LIST`, etc.).

---

## Production code (ALTER identity)

| File | Change |
|------|--------|
| `identities.ts` | `isTallyMasterGuid()` |
| `types.ts` | `ReportMetadataRecord.tally_master_guid` |
| `mapPreparedItem.ts` | Pass GUID from `delivery_state.tally_remote_id` on UPDATE |
| `xml/serialize.ts` | Alter: `<GUID>` when guid present; Create unchanged |

**Not hard-coded:** GUID only via **`tally_delivery_state.tally_remote_id`** (connector ack / post-create resolution). Validation script uses env **`PHASE53_TALLY_LEDGER_GUID`**.

---

## Test C — latest run (2026-10-06)

| Item | Value |
|------|--------|
| Prior remarks (delivery state hash) | `phase53-manual-alter-proof` → hash `a24607181a21e08a703356ba53659b6699a1b7756fe5b0ddb587c339463b91df` |
| New remarks | `phase53-test-c-production-alter-pass` → hash `ea5899f3769bbfec3a9ade201680c5f78abd8e0e3fbe1ba2c78ac2948834ec8b` |
| Decision | UPDATE → ACTION Alter |
| HTTP count | **1** |
| Response | `EXCEPTIONS=1` |

Script: `scripts/tally-integration/phase53-test-c-alter.ts`

---

## Safety

- 7 pending smoke batches **untouched**
- No connector, no TDL/TCP, no deploy

---

## Next manual / one-shot gate

1. Export **`PW-META-04fd0f3a4fa1`** XML from Tally (single ledger) **after** manual UDF save — redact company secrets; capture **`MASTERID`**, **`ALTERID`**, **`NAME`**, **`GUID`**, UDF block.
2. Compare to Test C sent XML (in script log).
3. Only then authorize **one** new HTTP with export-matched identity shape (not guessed).
