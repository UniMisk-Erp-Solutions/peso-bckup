# Metadata ledger UPDATE semantics — investigation (no Tally HTTP)

**Date:** 2026-10-06  
**TallyPrime:** 7.1 · **Company:** PesoWise Integration Test  
**Status:** CREATE **REAL TALLY PASS** · SKIP **PASS (0 HTTP)** · ALTER **REAL TALLY NOT PASS** (repeatable `EXCEPTIONS=1`)

Phase 5 transport is **not complete**. Do **not** blindly retry `ACTION="Alter"` until identity requirements are proven.

---

## 1. Root cause hypothesis

**Primary (evidence-backed):** Production **UPDATE** XML assumes **`LEDGER ACTION="Alter"` + `NAME.LIST`** is sufficient to replace UDF index **25001** on an existing ledger. **Repository evidence does not prove that shape for TallyPrime 7.1.** Phase 5.1 already proposed identifying updates by **Master ID or Name** (§7 UPDATE / idempotency) but **no metadata ledger `MASTERID` / `ALTERID` / `GUID` was ever captured** from export after HTTP create. Import responses only return aggregate counters (`CREATED` / `ALTERED` / `EXCEPTIONS`), not master IDs.

**Secondary:** **`PESOWISE_STABLE_KEY`** may not be registered in TDL on **Ledger** (only **`PESOWISE_METADATA_JSON`** is documented on ledger). CREATE tolerates extra UDF tags (`CREATED=1`); **Alter may validate stricter** — we tested both full Alter (with PARENT + STABLE_KEY) and minimal Alter (UDF only); **both** returned `EXCEPTIONS=1`.

**Not supported by repo evidence:** “Invalid JSON” as root cause for the latest attempt — `stableStringify` omits `undefined`; Alter JSON is valid escaped UTF-8.

---

## 2. Evidence supporting hypothesis

| Source | Finding |
|--------|---------|
| **PHASE-05.1** §7 | UPDATE should use **`LEDGER ACTION=Alter`** and identify by **Master ID or Name** — Master ID path **never validated** for metadata ledgers. |
| **PHASE-05.1** §6 / golden export | **PW-META-MANUAL-001** export shows **UDF `.LIST` + `INDEX="25001"`** — **not** a full `<LEDGER>` with `MASTERID`. |
| **PHASE-05.1** §HTTP-001 | CREATE **PASS** without `PESOWISE_STABLE_KEY`; **manual Alter + export still pending** for HTTP-001. |
| **Phase 5.3 Test A** | CREATE **PASS** with PARENT + STABLE_KEY + backtick DESC + `.LIST` (production serializer). |
| **Phase 5.3 Test C** | ALTER **FAIL** `EXCEPTIONS=1` (~78 ms), **no `LINEERROR`** in response — Tally rejects silently. |
| **`serializeMaster` (employee ledger)** | Alter includes **`LANGUAGENAME.LIST`**; **metadata ledger CREATE omits it** yet CREATE passes — unlikely sole cause of Alter failure. |
| **`_tally-probe-once.mjs`** | Example Alter uses `NAME.LIST` + `PARENT` only — **no recorded result** in docs. |
| **Voucher investigations (5.1)** | **MASTERID / ALTERID / GUID** documented for **vouchers**, not for **metadata ledgers**. |

**Missing Tally evidence (required before next HTTP):**

1. **Single-ledger export** of **`PW-META-04fd0f3a4fa1`** (current production CREATE) — full `<LEDGER>` tree including **`MASTERID`**, **`ALTERID`**, **`GUID`**, **`NAME`**, language lists.
2. **Same export after manual UI Alter** of UDF JSON only — diff identity fields.
3. Optional: same pair for **`PW-META-HTTP-001`** (HTTP golden create, no STABLE_KEY).

---

## 3. Identity fields in exported ledger (known vs unknown)

| Field | PW-META-MANUAL-001 (repo) | PW-META-04fd0f3a4fa1 | PW-META-HTTP-001 |
|-------|---------------------------|----------------------|------------------|
| `MASTERID` | **Unknown** (export fragment not in repo) | **Unknown** | **Unknown** |
| `ALTERID` | **Unknown** | **Unknown** | **Unknown** |
| `GUID` | **Unknown** | **Unknown** | **Unknown** |
| `NAME` / `NAME.LIST` | Name in UI | **PW-META-04fd0f3a4fa1** | **PW-META-HTTP-001** |
| UDF shape | `.LIST` + index **25001** | Same as production CREATE | `.LIST` (import DESC plain text) |

---

## 4. CREATE vs current UPDATE (production serializer)

See local diff (no HTTP): `npm.cmd exec --yes tsx -- scripts/tally-integration/phase53-print-create-vs-alter-xml.ts`

| Element | CREATE (Test A — PASS) | UPDATE (Test C — FAIL) |
|---------|------------------------|-------------------------|
| `ACTION` | Create | Alter |
| `NAME.LIST` | `PW-META-04fd0f3a4fa1` | same |
| `PARENT` | PesoWise Metadata | **omitted** (minimal Alter) |
| `UDF:PESOWISE_STABLE_KEY` | delivery key | **omitted** |
| `UDF:PESOWISE_METADATA_JSON.LIST` | index 25001, backtick DESC | same structure, **new JSON** |
| Envelope | `REPORTNAME=All Masters`, `SVCURRENTCOMPANY` | same |

**Also failed:** Alter with **PARENT + STABLE_KEY** included (earlier attempt, same `EXCEPTIONS=1`).

---

## 5. Recommended direct-update mechanism (do not HTTP until proven)

**Priority A — Evidence-led Alter (preferred if export confirms):**

1. From **after-create export**, read **`MASTERID`** (and if present **`ALTERID`**, **`GUID`**).
2. Build **one** candidate Alter XML documented in this file **after** export review, e.g. patterns to validate against export (not guesses):

   - `LEDGER` with **`NAME="PW-META-04fd0f3a4fa1"`** attribute (if export uses `NAME` not only `NAME.LIST`)
   - **`MASTERID`** / **`ALTERID`** children matching export
   - UDF block **matching export tag hierarchy** exactly (`.LIST` vs flat `TYPE="String"`)
   - **`LANGUAGENAME.LIST`** if export includes it

3. Persist **`tally_remote_id`** from export (Master ID or canonical name) in **`tally_delivery_state`** on first successful CREATE ack (connector ack path already supports `tally_remote_id`).

**Priority B — Create-as-upsert (single controlled test only if A blocked):**

- One HTTP test: **`ACTION="Create"`** with **same `NAME.LIST`** and **new UDF JSON** on existing ledger.
- **Accept only if** Tally returns **`ALTERED=1`** or **`CREATED=0`/`ALTERED=1`** with **`EXCEPTIONS=0`** and manual inspection shows **one** ledger, updated JSON.
- **Reject** if Tally creates a second master or raises `EXCEPTIONS`.

**Rejected until proven otherwise:** delete + recreate; versioned duplicate names under normal path.

---

## 6. Append-only fallback (design only — NOT active)

**Activate only if** direct update cannot be made reliable on 7.1.

| Aspect | Direct update (target) | Append-only fallback |
|--------|------------------------|----------------------|
| Ledger name | `PW-META-{sha256(K)[0:12]}` | `PW-META-{sha256(K)[0:12]}-{H[0:8]}` per content hash **H** |
| K + H1 first time | CREATE L | CREATE L₁ |
| K + H1 again | SKIP | SKIP |
| K + H2 | UPDATE same L | CREATE L₂ (L₁ immutable) |
| Accounting impact | None | None |
| TDL | One ledger per row key | Collection over group; **filter `metadata_delivery_key=K`; pick max `content_hash` or version** |
| Delivery state | `tally_remote_id` = stable name | `tally_remote_id` = **latest** physical name; history retained |
| Risk | Low if Alter works | More masters over time; TDL must dedupe by K |

Tradeoffs: append-only is **safe** for books (still no voucher lines) but **more masters** and **stricter TDL**; avoids unreliable Alter.

---

## 7. Manual Alter + export instructions (human, no GUI automation)

**Ledger:** `PW-META-04fd0f3a4fa1` (do **not** change name or parent group).

### Before manual change (if not already saved)

1. Company **PesoWise Integration Test**.
2. **Gateway of Tally → Display → Account Info → Ledgers** (or **Alter** from group **PesoWise Metadata**).
3. Open **`PW-META-04fd0f3a4fa1`** → note current **PESOWISE_METADATA_JSON** (expect Test A token `phase53-test-a-controlled-create`).
4. **Export this ledger only:** e.g. **Account Info → Ledgers → select ledger → Export** (or Data Exchange for **one** ledger). Save as `PW-META-04fd0f3a4fa1-before.xml` **outside git if it contains company data**.

### Manual Alter

1. **Alter** the same ledger.
2. Change **only** the UDF / **PESOWISE_METADATA_JSON** field to valid JSON with `"remarks":"phase53-manual-alter-probe"` (keep other keys intact if possible).
3. **Accept / save**. Confirm no opening balance and no voucher side-effects.

### After manual change

1. Export **the same ledger again** → `PW-META-04fd0f3a4fa1-after.xml`.
2. Diff for: **`MASTERID`**, **`ALTERID`**, **`GUID`**, **`NAME`**, **`LANGUAGENAME.LIST`**, UDF nesting.
3. Paste redacted snippets into this doc (or attach to ticket) — **do not commit live company secrets**.

Repeat optionally on **`PW-META-HTTP-001`** (Phase 5.1 pending follow-up).

**Do not** run broad Collection exports or voucher exports.

---

## 8. Quarantine status (Step 5A)

| Item | Status |
|------|--------|
| Migration in repo | `20261007140000_tally_quarantine_smoke_batches.sql` |
| Apply script | `scripts/tally-integration/apply-quarantine-migration-only.mjs` |
| Dry-run | **Not run** — `TALLY_VALIDATE_ADMIN_*` and `DEPLOY_SSH_PASSWORD` **missing** in agent environment |

**When creds available:**

```text
node scripts/tally-integration/list-and-quarantine-smoke-batches.mjs
# review JSON — confirm ~7 pending batches, org 80ab039f-f9e2-4c76-8b5b-e65b15d66af9, smoke context
# deploy migration if RPC missing:
#   DEPLOY_SSH_PASSWORD=... node scripts/tally-integration/apply-quarantine-migration-only.mjs
QUARANTINE_CONFIRM=1 TALLY_VALIDATE_ADMIN_EMAIL=... TALLY_VALIDATE_ADMIN_PASSWORD=... node scripts/tally-integration/list-and-quarantine-smoke-batches.mjs
```

**Quarantine is independent of ALTER** — recommended to run as soon as creds exist so connector cannot claim old batches.

---

## 9. Connector readiness

| Check | Result |
|-------|--------|
| EXE path | `connector/tally/dist/PesoWise-Tally-Connector.exe` |
| Standalone / no Node | **PASS** (pkg build) |
| Smoke start | **PASS** — exits with expected “Missing config … Run pair first.” (no snapshot crash) |
| Batch delivery | **Disabled** until pairing + fresh job + ALTER strategy resolved |

---

## 10. Pairing readiness

| Check | Result |
|-------|--------|
| RPCs in migration | **Present** (automated migration tests) |
| Live pair | **NOT RUN** — admin env missing |
| Token in logs | N/A |

Pairing does **not** require metadata Alter.

---

## 11. Tests

**198 / 198** tally-scoped tests **PASS** (includes Alter XML omit PARENT/STABLE_KEY on `action=alter`).

No Tally HTTP during this investigation.

---

## 12. ONE next controlled Tally test (present only — do not auto-run)

**After** before/after manual export diff:

**Test C′ — Master-ID-led Alter (candidate name):**

- **Precondition:** Export provides numeric **`MASTERID`** (and optional **`ALTERID`**) for `PW-META-04fd0f3a4fa1`.
- **HTTP:** exactly **1** request, 15s timeout, company **PesoWise Integration Test**.
- **Body:** `LEDGER ACTION="Alter"` with **export-proven identity fields** + UDF JSON containing `phase53-test-c-controlled-alter` and hash `41e31f2d…`.
- **Pass:** `ALTERED=1`, `EXCEPTIONS=0`.
- **Fail:** stop; consider **Test C″** (single Create-as-upsert) or append-only design.

If export shows **no MASTERID** and only name: **Test C″** — one **`ACTION="Create"`** with same name + new JSON (upsert probe).

---

## 13. Related files

| Path |
|------|
| `src/lib/tallyMapping/xml/serialize.ts` — `serializeMetadataLedger` |
| `scripts/tally-integration/phase53-print-create-vs-alter-xml.ts` |
| `scripts/tally-integration/phase53-test-c-alter.ts` |
| `docs/tally-integration/TALLY-TDL-READ-MODEL-CONTRACT.md` — dual model note |
