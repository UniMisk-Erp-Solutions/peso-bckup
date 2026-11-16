# Phase 5.1 — Deploy, build connector & real Tally validation

**Date:** 2026-10-06  
**Server (.46):** **SERVER SIDE READY — SWITCH TO TALLY NETWORK** (see § SERVER DEPLOYMENT ON .46)  
**Tally PC (2026-10-06 session):** **MANUAL LEDGER UDF PERSISTENCE = PASS** · **AUTOMATED LEDGER IMPORT (HTTP) = PASS** (manual export/Alter confirmation pending for **PW-META-HTTP-001**)

---

## SERVER DEPLOYMENT ON .46 (2026-10-06)

| Step | Result |
|------|--------|
| Ping `192.168.23.46` | **PASS** |
| TCP 22 / SSH `hasto` | **PASS** |
| Phase 4 migration | **Applied** |
| Phase 5 migration + load-RPC fix | **Applied** |
| Edge functions | **Deployed** (`run-tally-sync-delivery`, `tally-connector` → **401** without auth) |
| Backend smoke | **`waiting_for_connector`**, 7 **`pending`** batches, **0** `tally_delivery_state` |
| Automated tests (post-deploy) | **161 passed** |

Public connector URL: `https://pesowise-backup-supabase.unimisk.com/functions/v1/tally-connector`

---

## TALLY-SIDE VALIDATION (2026-10-06, Tally network)

### Connectivity

| Check | Result |
|-------|--------|
| `127.0.0.1:9000` TCP | **Open** when TallyPrime integration running |
| Company collection | **`PesoWise Integration Test` present** |
| Public `tally-connector` (no token) | **HTTP 401** `Unauthorized` (not 500/DNS failure) |
| Direct `.46` / SSH | **Not used** (by design on Tally PC) |

### Connector EXE fix

| Item | Result |
|------|--------|
| Root cause | `pkg` + `"type":"module"` ESM entry → broken snapshot `C:\snapshot\tally\dist\main.js` |
| Fix | Connector build → **CommonJS** (`tsconfig`); `pkg dist/main.js` (not `pkg .`) |
| Artifact | `connector/tally/dist/PesoWise-Tally-Connector.exe` (~37.7 MB) |
| `run` (no config) | **Expected** — “Missing config … Run pair first.” |
| `pair` (no args) | **Expected** — usage line (no snapshot error) |

### Test organization (approved)

| Field | Value |
|-------|--------|
| `organization_id` | `80ab039f-f9e2-4c76-8b5b-e65b15d66af9` |
| Tally company | **PesoWise Integration Test** |
| Admin RPCs | **Not run** — no `TALLY_VALIDATE_ADMIN_EMAIL` / `TALLY_VALIDATE_ADMIN_PASSWORD` in environment |

Script (HTTPS only): `scripts/tally-integration/tally-phase51-backend-setup.mjs`

### Smoke-batch isolation (7 pending / 168 items)

**Not executed** — requires `VALIDATE_SUPABASE_SERVICE_ROLE_KEY` to PATCH batches to **`skipped`** and mark smoke job **`failed`** with safe message (no false Tally ack). Mechanism documented in setup script; not applied yet.

### Micro tests (`local-tally-micro-test.mjs`)

Bootstrap via XML (group, voucher types, ledgers) → micro imports.

| Test | Result | Notes |
|------|--------|-------|
| Master (ledger + `PESOWISE_STABLE_KEY`) | **PASS** | Plain ledger without UDF returned `EXCEPTIONS=1`; production-shaped XML **CREATED=1** |
| Voucher (`PesoWise Expense`, cat debit / emp credit) | **PASS** | **CREATED=1**; narration “Synthetic micro test” |
| Metadata (`PESOWISE_METADATA_JSON`) | **FAIL → BOOTSTRAP TDL** | `EXCEPTIONS=1`, no `LINEERROR` text; voucher not created; UDF not readable |

**Metadata XML shape (redacted):** `VCHTYPE="PesoWise Report Meta"` + `<UDF:PESOWISE_METADATA_JSON TYPE="String">…escaped JSON…</UDF:PESOWISE_METADATA_JSON>`

**Minimum bootstrap TDL (manual):** Define **String UDF** `PESOWISE_METADATA_JSON` on voucher type **`PesoWise Report Meta`** (and ensure type exists). Load TDL **before** metadata import/readback. Do **not** implement final four reports in Phase 5.1.

### Metadata round-trip after bootstrap TDL (TallyPrime Release 7.0)

**Bootstrap TDL loaded (manual):**

```tdl
[System : UDF]
PESOWISE_METADATA_JSON : String : 25001
```

| Step | Result |
|------|--------|
| `127.0.0.1:9000` | **Reachable** (HTTP 200; intermittent timeouts when Tally busy) |
| Company **`PesoWise Integration Test`** | **Present** (Company collection export) |
| Ensure voucher type **`PesoWise Report Meta`** (XML) | **FAIL** — `CREATED=0`, `EXCEPTIONS=1`, no `LINEERROR` |
| Metadata import (production-shaped XML, full JSON torture-test) | **FAIL** — `CREATED=0`, `ALTERED=0`, `ERRORS=0`, `EXCEPTIONS=1`, no `LINEERROR` |
| Readback / JSON compare | **Not reached** (import did not persist voucher) |

**Import envelope (structure, redacted):** `REPORTNAME=All Masters`, `SVCURRENTCOMPANY=PesoWise Integration Test`, `VCHTYPE=PesoWise Report Meta`, `UDF:PESOWISE_METADATA_JSON TYPE="String"` with XML-escaped JSON (Unicode, `&`, `<>`, quotes, newline, nested object).

**Example Tally response (actual):**

```xml
<RESPONSE>
 <CREATED>0</CREATED>
 <ALTERED>0</ALTERED>
 <EXCEPTIONS>1</EXCEPTIONS>
</RESPONSE>
```

**Diagnosis (metadata-only):** System-level UDF definition alone did **not** unlock import. **`PesoWise Report Meta` voucher type is not present** in the company (export `Voucher Type` collection empty / type missing), and XML creation of that voucher type also returns **`EXCEPTIONS=1`**. Until the voucher type exists and accepts the UDF on import, round-trip cannot pass. Likely bootstrap TDL must also declare the **voucher type** (and/or attach the UDF at voucher-type scope) — **not changed automatically** per Phase 5.1 rules.

Script: `scripts/tally-integration/local-tally-metadata-roundtrip.mjs` (import + readback gate).

### Metadata retest after manual voucher type (2026-10-06)

**Manual setup:** Voucher type **`PesoWise Report Meta`** created in GUI (base **Journal**). Bootstrap TDL `[System : UDF] PESOWISE_METADATA_JSON : String : 25001` loaded.

**Read-only prechecks (no writes):**

| Check | Result |
|-------|--------|
| `127.0.0.1:9000` HTTP | **PASS** (Company catalog export, len > 100) |
| Company **`PesoWise Integration Test`** in catalog | **PASS** |
| Company active on integration (`SVCURRENTCOMPANY` export) | **PASS** |
| Voucher type **`PesoWise Report Meta`** readback (`Voucher Type` collection) | **PASS** (export len ~13k, name present) |

**Single metadata import** (`local-tally-metadata-roundtrip-v2.mjs`, **one attempt, no retry**):

- Envelope: same as prior working expense micro-test (`REPORTNAME=All Masters`, `SVCURRENTCOMPANY`, production `escapeXmlText` on JSON).
- Body: `VCHTYPE="PesoWise Report Meta"`, `UDF:PESOWISE_METADATA_JSON TYPE="String"`, unique narration token `PW-META51-*`.
- **Response:** `CREATED=0`, `ALTERED=0`, `ERRORS=0`, **`EXCEPTIONS=1`**, **no `LINEERROR`**.

**Readback:** **Not run** (import did not persist voucher).

**Classification (remaining blocker):** **C — voucher structure** (primary hypothesis): type is **Journal-based** but import XML has **no `ALLLEDGERENTRIES.LIST`** (unlike working **`PesoWise Expense`** micro-voucher). Secondary: **B — UDF XML namespace/shape** if Journal allows zero lines but UDF tag is rejected silently. **A** less likely now that type + system UDF exist and type readback succeeds.

**No further REPORTNAME probes or import retries** in this session per Phase 5.1 stop rule.

### Balanced-ledger metadata test (2026-10-06)

**Hypothesis:** Journal-based **`PesoWise Report Meta`** failed with **`EXCEPTIONS=1`** because prior XML had **no ledger lines** (working **`PesoWise Expense`** always had balanced `ALLLEDGERENTRIES.LIST`).

| XML | Structure |
|-----|-----------|
| **A (success)** | `VCHTYPE=PesoWise Expense` + `PW-SYNTH-CAT` / `PW-SYNTH-EMP` ±100, no UDF |
| **B (failed)** | `VCHTYPE=PesoWise Report Meta` + UDF only, no ledger lines |
| **C (one shot)** | Same ledger lines as **A** (amount **±1**) + `xmlns:UDF` + `PESOWISE_METADATA_JSON`; `VCHTYPE=PesoWise Report Meta` |

**Single import result (C):**

| Field | Value |
|-------|--------|
| CREATED | **1** |
| ALTERED | **0** |
| ERRORS | **0** |
| EXCEPTIONS | **0** |
| LINEERROR | none |
| LASTVCHID | **3** |

**Conclusion (INVALIDATED 2026-10-06):** ~~“With lines present, Tally accepts the metadata voucher XML (UDF included).”~~ Manual **Current Voucher → Export → XML** proves the persisted object is **`Payment` #3** with synthetic ledgers and **no UDF tag at all**. **`CREATED=1` is not metadata/UDF success.** See § Metadata persistence design diagnostic.

**Readback:** HTTP export attempts blocked/empty; **authoritative proof** is manual Data Interchange export (below).

---

## TallyPrime stability / crash diagnostic (2026-10-06) — READ-ONLY, NO WRITES

**Hard gate:** No further Tally **imports** or unbounded **exports** until a **single-voucher** readback strategy is approved and Tally is stable.

### Successful import (do not repeat)

| Field | Value |
|-------|--------|
| CREATED | **1** |
| EXCEPTIONS | **0** |
| LASTVCHID | **3** |
| Date | **20260406** |
| VCHTYPE | **PesoWise Report Meta** |
| Structure | Balanced **±1** on `PW-SYNTH-CAT` / `PW-SYNTH-EMP` + `PESOWISE_METADATA_JSON` |
| Narration pattern | `Phase51 balanced meta PW-META-BAL-<suffix>` |

### Observed Tally termination

- Windows **Application Error** / **WER APPCRASH** for **`tally.exe`** at **~12:35:09** (exception **`0xc0000005`** access violation).
- Earlier crash **~12:15–12:16** same signature (prior session).
- **New** `tally.exe` process after restart (**~12:36:04**); **`127.0.0.1:9000` LISTENING** again (gateway/server).
- User report: error dialog then Tally closed — consistent with **process crash**, not a clean shutdown.

### Request active before failure (most likely)

Immediately after successful import, **`local-tally-metadata-balanced-once.mjs`** issued **READBACK #1**:

- **Not an import** — `TALLYREQUEST=Export`, `TYPE=Collection`, **`ID=VOUCHER`**
- **No** `REPORTNAME` (export path, not import)
- **`SVCURRENTCOMPANY`:** PesoWise Integration Test
- **`SVFROMDATE` / `SVTODATE`:** **20260401–20260430** (30-day window)
- **No** voucher-type filter, **no** single-voucher key
- Client **60s timeout** → `export_timeout`

This is the **first** post-import export and the strongest correlate with the **~12:35** crash (client waited while Tally processed a **collection** export).

**Subsequent readback attempts (also timed out; do not re-run blindly):**

| # | Script | TYPE | ID | Dates | Filter |
|---|--------|------|-----|-------|--------|
| 2 | `_readback-balanced-meta.mjs` | Collection | VOUCHER | 20260406–20260406 | none |
| 3 | PowerShell | Data | Day Book | 20260406–20260406 | none |
| 4 | PowerShell | Collection | VOUCHER | 20260406–20260406 | SVVOUCHERTYPE=PesoWise Report Meta |

**Redacted XML template (READBACK #1 — the risky one):**

```xml
<?xml version="1.0"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>VOUCHER</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>PesoWise Integration Test</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>20260401</SVFROMDATE>
        <SVTODATE>20260430</SVTODATE>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>
```

### Suspected cause (readback / stability)

1. **`TYPE=Collection` + `ID=VOUCHER`** is **not** the same pattern as proven-safe probes (`Company`, `Voucher Type`, `Ledger`) and may trigger **large or invalid collection walks** in TallyPrime 7.
2. **Multi-day / unbounded voucher collection export** over HTTP can produce **very large responses** or internal stress → **UI lockup**, **HTTP hang**, **`tally.exe` crash** (`c0000005`).
3. **Not** attributed to bootstrap TDL on import (import with UDF **succeeded**). Crash timing aligns with **export**, not import.
4. **`Day Book`** report export can also be heavy; single-day timeout suggests server already failing under load or post-crash.

### Bootstrap TDL static review

```tdl
[System : UDF]
PESOWISE_METADATA_JSON : String : 25001
```

- **No** formulas, **no** collections, **no** recursive report definitions.
- **Statically low risk**; does not explain crash during **Export** after successful **Import**.
- UDF readback may still require **Object** export with explicit **FETCH** — not proven yet.

### Proposed bounded readback (DO NOT EXECUTE YET)

**Goal:** Read **only** voucher **LASTVCHID=3** (same physical voucher; narration token `Phase51 balanced meta PW-META-BAL-…`).

**Preferred: Object export by voucher name (narration is unique):**

```xml
<?xml version="1.0"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Object</TYPE>
    <SUBTYPE>Voucher</SUBTYPE>
    <ID TYPE="Name">Phase51 balanced meta PW-META-BAL-[SUFFIX]</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>PesoWise Integration Test</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <FETCHLIST>
        <FETCH>Date</FETCH>
        <FETCH>VoucherTypeName</FETCH>
        <FETCH>Narration</FETCH>
        <FETCH>PESOWISE_METADATA_JSON</FETCH>
      </FETCHLIST>
    </DESC>
  </BODY>
</ENVELOPE>
```

**Fallback (if Name lookup differs in Release 7):** Object export with **`ID TYPE="Number"`** matching internal voucher number **3** and same **`FETCHLIST`** (minimal fields only).

**Before any HTTP retry:**

1. Manually open **PesoWise Integration Test** in TallyPrime (no TallyDrive login if not needed).
2. Confirm voucher **3** / narration visible in UI (manual integrity check).
3. Run **only one** Object export with **short client timeout** (e.g. 15s) and **no** Collection/Day Book exports.

**Manual zero-HTTP option:** Display **`PESOWISE_METADATA_JSON`** on voucher alteration screen / column — confirms persistence without integration export.

---

## Voucher type mismatch diagnostic (2026-10-06) — no HTTP

### Manually confirmed persisted voucher #3

| Field | Value |
|-------|--------|
| Company | PesoWise Integration Test |
| Date | 06-Apr-2026 |
| Voucher No. | **3** |
| Narration | `Phase51 balanced meta PW-META-BAL-mwbu7q3` |
| Ledgers | PW-SYNTH-CAT **1.00**, PW-SYNTH-EMP **-1.00** |
| **Tally Alter screen type shown** | **Payment** (not “PesoWise Report Meta”) |

Import XML had **`VCHTYPE="PesoWise Report Meta"`** and Tally returned **`CREATED=1`**, **`LASTVCHID=3`**.

### Code / XML evidence

**Production metadata (`serializeMetadata`):** only `VCHTYPE="PesoWise Report Meta"`, **no** ledger lines, **no** `VOUCHERTYPENAME` / `PERSISTEDVIEW` / `ISINVOICE` / `OBJVIEW`.

**Balanced Phase 5.1 test (`local-tally-metadata-balanced-once.mjs`):** same `VCHTYPE`, but **copied PesoWise Expense ledger block** (`PW-SYNTH-CAT` debit / `PW-SYNTH-EMP` credit, `ISDEEMEDPOSITIVE` Yes/No) — **Payment-shaped** body on a **Journal-named** type.

**PesoWise Expense (known good):** `VCHTYPE="PesoWise Expense"` + **identical ledger pattern**; bootstrap master **`PARENT>Payment</PARENT>`**.

**PesoWise Report Meta bootstrap in repo:** consistently **`PARENT>Journal</PARENT>`** (`local-tally-micro-test.mjs`, `roundtrip.mjs`, `_bootstrap-and-meta.mjs`). Manual GUI creation also **Journal** base — **intent is Journal-based**; not Payment-based in our scripts.

### Strongest supported hypothesis

**Primary: (C) structure-driven reclassification** — Tally accepted the XML and allocated voucher number **3**, but **persisted/displayed the voucher under the Payment class** because the **ledger semantics match a Payment voucher** (same pattern as **`PesoWise Expense`**, whose master is Payment-based), despite the **`VCHTYPE`** attribute saying `PesoWise Report Meta`.

**Contributing:** Phase 5.1 **diagnostic** import deliberately grafted **expense/payment ledger lines** onto metadata XML to fix `EXCEPTIONS=1`; that is **not** the Phase 4 production shape (metadata-only, no lines).

**Less likely alone:** (A) custom master base Payment — repo + manual setup say **Journal**; (B) explicit XML forcing Payment — **no** `VCHTYPE=Payment` in our import.

### Is voucher #3 valid for metadata readback?

- **Physically persisted** with expected narration/amounts — **yes**.
- **Type identity for API export** — treat as **`Payment` / No. 3 / 06-Apr-2026** until Object export proves otherwise; **do not** filter exports on `SVVOUCHERTYPE=PesoWise Report Meta` (would **exclude** this voucher — likely why readback exports hung/returned empty).
- **UDF** — unknown until manual Alter shows `PESOWISE_METADATA_JSON` or a bounded Object export succeeds; import did include UDF in XML.

### Smallest correction (future, not executed here)

1. **Production metadata** should remain **Phase 4 shape** (UDF only, no payment ledger lines) once Journal type accepts it — **or** use ledger lines that match **Journal** rules, not Payment clone.
2. **Readback/export** must use **UI-resolved type** (`Payment`, `#3`, date) not assumed `PesoWise Report Meta`.
3. Avoid **Collection `ID=VOUCHER`** bulk exports.

### Safest proposed Object readback (DO NOT RUN YET)

Prefer **static variables** over narration-as-`ID TYPE="Name"`:

```xml
<TYPE>Object</TYPE>
<SUBTYPE>Voucher</SUBTYPE>
<!-- HEADER ID omitted or use AlterID once known from UI/export -->
<STATICVARIABLES>
  <SVCURRENTCOMPANY>PesoWise Integration Test</SVCURRENTCOMPANY>
  <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
  <SVFROMDATE>20260406</SVFROMDATE>
  <SVTODATE>20260406</SVTODATE>
  <SVVOUCHERTYPE>Payment</SVVOUCHERTYPE>
  <SVVOUCHERNUMBER>3</SVVOUCHERNUMBER>
</STATICVARIABLES>
<FETCHLIST>Date, VoucherTypeName, Narration, PESOWISE_METADATA_JSON</FETCHLIST>
```

**Next safe test (manual first):** On voucher **Payment #3**, confirm **`PESOWISE_METADATA_JSON`** in Alter; then **one** Object export with the above keys and **≤15s** timeout.

---

## Safe single-voucher UDF readback (2026-10-06) — one HTTP request only

### Manual UI (pre-request)

| Field | Value |
|-------|--------|
| Company | PesoWise Integration Test |
| Date | 06-Apr-2026 |
| Displayed type | **Payment** |
| Voucher No. | **3** |
| Narration | `Phase51 balanced meta PW-META-BAL-mwbu7q3` |
| Ctrl+I / More Details | Standard fields only; **`PESOWISE_METADATA_JSON` not shown** (does **not** prove UDF absent) |

### Step 1 — static validation (no HTTP)

| Assumption | Verdict |
|------------|---------|
| Narration = Object `ID TYPE="Name"` | **Not used** — Tally object naming for vouchers not verified in repo |
| Voucher No. 3 = internal master / `LASTVCHID` | **Not assumed** — import `LASTVCHID=3` is not proof of export key |
| `TYPE=Object` + arbitrary `ID` | **Invalid without proven ID scheme** |
| Collection `VOUCHER` / Day Book / date-range bulk export | **Forbidden** (crash history) |

**Chosen bounded method (single-object intent):**

- `TYPE=Object`, `SUBTYPE=Voucher`
- **No** `ID` element (static variables only to select one voucher)
- `SVCURRENTCOMPANY=PesoWise Integration Test`
- `SVFROMDATE` / `SVTODATE` = **20260406** (single day)
- `SVVOUCHERTYPE=**Payment**` (UI-resolved type)
- `SVVOUCHERNUMBER=**3**`
- Minimal `FETCHLIST`: Date, VoucherTypeName, VoucherNumber, Narration, MasterId, AlterId, GUID, PESOWISE_METADATA_JSON
- **No** ledger / inventory / bills / nested collections

Script: `scripts/tally-integration/local-tally-safe-single-voucher-readback-once.mjs`

**Expected import JSON** (token fixed at import time `PW-META-BAL-mwbu7q3`): same structure as `local-tally-metadata-balanced-once.mjs` — `schema_version`, `report_type`, `roundtrip_token`, `fields` (ASCII, Unicode नोट, `&`, `<>`, quotes, newline, nested object).

### Step 2 — safety gate + single request

| Check | Before | After |
|-------|--------|-------|
| `tally.exe` running | **yes** | **yes** |
| TCP **127.0.0.1:9000** listening | **yes** | **yes** |
| HTTP requests sent | **1** | — |
| Client timeout | **15s** | — |
| Elapsed | — | **~14 ms** |
| HTTP status | — | **200** |
| Response length | — | **53 bytes** |

**Response body (complete):**

```xml
<ERRORMSG>Could not find Voucher:(null)!</ERRORMSG>
```

**Interpretation:** TallyPrime Object export **requires a non-null voucher object identifier** in the request; **`SVVOUCHERTYPE` + `SVVOUCHERNUMBER` + single-day dates alone do not resolve the object** when `HEADER` `ID` is omitted. Fast error (not a hang); **no** crash; **no** retry per gate.

### Step 3 — result

| Check | Result |
|-------|--------|
| Target voucher returned | **No** |
| Identity (date / #3 / narration) | **Not verified** |
| `PESOWISE_METADATA_JSON` | **Not retrieved** |
| JSON logical equality | **N/A** |

**Classification:** **SAFE READBACK BLOCKED**

**Follow-up hypothesis (not executed — one-request limit):** Object export may need an explicit `ID` (e.g. AlterId/MasterId from UI, or Tally-documented `ID TYPE="Field"` + `NAME="VoucherNumber"` **with** `SVVOUCHERTYPE`) — must be validated statically against TallyPrime 7 docs before any second HTTP attempt.

---

## Targeted voucher identity lookup design (2026-10-06)

### Goal

Discover **MasterID / AlterID / GUID** for the manually confirmed voucher (Payment **#3**, **06-Apr-2026**, narration `Phase51 balanced meta PW-META-BAL-mwbu7q3`) **without** built-in `Collection ID=VOUCHER`, Day Book, broad date-range exports, or guessed Object `ID`s.

### Step 1 — static analysis (no HTTP)

| Approach | Verdict |
|----------|---------|
| Built-in `TYPE=Collection` **`ID=VOUCHER`** | **Forbidden** — prior hangs / `tally.exe` **0xc0000005** |
| Day Book / wide `SVFROMDATE`–`SVTODATE` voucher dumps | **Forbidden** |
| `Object` export with only `SVVOUCHERTYPE` + `SVVOUCHERNUMBER` | **Proven insufficient** — `Could not find Voucher:(null)!` |
| **Inline custom collection** in export `TDL` block | **Allowed pattern** per [Tally Case Study 1](https://help.tallysolutions.com/article/DeveloperReference/integration-capabilities/case_study_1.htm): `HEADER ID` = custom collection name; `COLLECTION` defined under `TDLMESSAGE` with `TYPE`, `FILTER`, `FETCH` |

**Designed collection (not the built-in VOUCHER collection):**

- `NAME=PWPhase51OneVchLookupColl`
- `TYPE=Voucher`
- `FILTER` → `SYSTEM TYPE=Formulae` combining:
  - `$Date = $$Date:20260406`
  - `$VoucherTypeName = "Payment"`
  - `$VoucherNumber = "3"`
  - `$Narration = "Phase51 balanced meta PW-META-BAL-mwbu7q3"`
- `FETCH` only: `Date`, `VoucherTypeName`, `VoucherNumber`, `Narration`, `MasterID`, `AlterID`, `GUID`
- **No** ledger / inventory / bills / UDF / wildcards

**Filter vs serialization (honest limit):** Tally documents `FILTER` on collections and explicit `FETCH` for exported methods. We **cannot prove from repo alone** that TallyPrime 7 never touches ledger subgraph for non-matching vouchers; the **intent** is filter-first membership + minimal `FETCH`. Empty or tiny responses and fast latency are the runtime safety signals.

**Static go/no-go:** Pattern is **documented and bounded** enough for **one** 15s probe (not `ID=VOUCHER`).

Script: `scripts/tally-integration/local-tally-targeted-voucher-lookup-once.mjs`

### Step 2 — one controlled request

| Check | Before | After |
|-------|--------|-------|
| `tally.exe` | **yes** | **yes** |
| `127.0.0.1:9000` | **yes** | **yes** |
| Requests | **1** | — |
| Timeout | **15s** | — |
| Elapsed | — | **~42 ms** |
| HTTP | — | **200** |
| Body size | — | **~1511 bytes** |

**Result body:** `CMPINFO` shows `<VOUCHER>0</VOUCHER>`; `DATA` contains an **empty** `<COLLECTION …>` — **no** `DATE` / `NARRATION` / `MASTERID` fields.

### Step 3 — identity

**Not found** — zero matching vouchers in export (not a multi-voucher leak; not a timeout; Tally stayed up).

**Likely cause (hypothesis, not re-tested):** TDL filter method names / date literal / voucher-number comparison for Payment **#3** on Release 7 may differ from the formula used (e.g. `$VoucherNumber` type, `$$Date:` format, or narration exact-match). **Do not guess** alternate Object IDs; next step requires **Tally-validated filter syntax** (manual export of one voucher XML from Tally UI, or official TP7 formula reference) before another HTTP attempt.

**Classification:** **TARGETED LOOKUP RUNTIME BLOCKED**

---

## Metadata persistence design diagnostic (2026-10-06) — static only, no HTTP

### Authoritative manual export (TallyPrime Data Interchange)

Source: **Current Voucher → Export → XML** on the voucher created by the balanced-ledger Phase 5.1 import (not integration API).

| Field | Exported value |
|-------|----------------|
| Date | **20260406** |
| Narration | `Phase51 balanced meta PW-META-BAL-muwbu7q3` |
| Voucher Number | **3** |
| VCHTYPE / VOUCHERTYPENAME / VCHSTATUSVOUCHERTYPE / VOUCHERTYPEORIGNAME | **Payment** (all) |
| GUID / REMOTEID | `ff2a6be2-de9a-4019-933a-e47a348056e3-00000003` |
| MASTERID | **3** |
| ALTERID | **3** |
| Ledger lines | **PW-SYNTH-CAT** / **PW-SYNTH-EMP** present |
| **`PESOWISE_METADATA_JSON`** | **Absent** — no `UDF:` tag, no `.LIST`, no `INDEX="25001"` |

**Invalidated assumptions (contradicted by this export):**

| Prior assumption | Status |
|------------------|--------|
| `CREATED=1` ⇒ UDF persisted | **False** |
| Import `VCHTYPE="PesoWise Report Meta"` ⇒ persisted type | **False** (persisted **Payment**) |
| ±1 ledger lines are a valid metadata strategy | **Rejected** (creates real accounting; wrong type) |
| `Ctrl+I` missing UDF ⇒ “maybe still stored” | **False** — Tally’s own full XML export would include a persisted voucher UDF ([Tally UDF Index FAQ](https://help.tallysolutions.com/article/DeveloperReference/faq/9242.html)) |
| Structure-driven Payment hypothesis needs HTTP proof | **Confirmed** by export ground truth |

**Gate:** No further HTTP readback on voucher **#3**; do not pair connector; do not run smoke batches / real sync / Phase 6 until metadata persistence is re-proven on a **new** test voucher.

### Code baseline (Phase 4 — intended production shape)

`serializeMetadata()` (`src/lib/tallyMapping/xml/serialize.ts`):

- `VCHTYPE="PesoWise Report Meta"`
- Date + fixed narration
- **`UDF:PESOWISE_METADATA_JSON TYPE="String"`** only — **no** `ALLLEDGERENTRIES.LIST` (correct intent: no fake amounts)
- Envelope: `REPORTNAME=All Masters` (same as other imports)

Bootstrap voucher type (repo): `VOUCHERTYPE` **`PesoWise Report Meta`**, **`PARENT>Journal`**, Manual numbering (`local-tally-micro-test.mjs`).

Bootstrap TDL (manual today):

```tdl
[System : UDF]
PESOWISE_METADATA_JSON : String : 25001
```

(Ledger micro-test **`PESOWISE_STABLE_KEY`** proved **ledger** UDF import can work with System UDF + XML tag; **voucher** metadata did not.)

### 1. Why `PesoWise Report Meta` became **Payment**

**Strongest evidence-backed explanation:** The Phase 5.1 diagnostic import (**C**) sent **`VCHTYPE="PesoWise Report Meta"`** but a **Payment-class voucher body**: two `ALLLEDGERENTRIES.LIST` lines on **PW-SYNTH-CAT** / **PW-SYNTH-EMP** with **`ISDEEMEDPOSITIVE` Yes/No** — the same pattern as the working **`PesoWise Expense`** micro-voucher (`PARENT>Payment`).

Tally persisted what the **body** represents: a **Payment** transaction with real ± amounts. The **`VCHTYPE` attribute alone did not win** over payment-shaped ledger semantics. Manual export shows **every** type field set to **Payment**, not merely the Alter screen label.

This is **not** evidence that the **`PesoWise Report Meta`** master is Payment-based (repo/GUI intent remains **Journal** parent); it is evidence that **this import message** was stored as **Payment**.

### 2. Why **`PESOWISE_METADATA_JSON`** is missing from Tally’s export

**Ground truth:** If the UDF value were stored on the voucher object, TallyPrime Data Interchange export should emit a **`UDF:`…** element (often with **`INDEX`** for the numeric slot — here **25001**).

**Absent UDF in export ⇒ the JSON was not attached to the persisted voucher object**, despite appearing in the inbound import XML and despite **`CREATED=1`**.

Contributing factors (static, consistent with Tally docs + session evidence):

| Factor | Notes |
|--------|--------|
| **Wrong persisted voucher class** | Object saved as **Payment** with accounting lines; inbound UDF may be **ignored or stripped** when not valid for the resolved voucher shape/type. |
| **`[System : UDF]` alone may be insufficient for voucher XML import** | Tally states a UDF **“does not come into existence until … value is stored … and attached with an Internal Object”** and that **`Storage`** on a **Field** binds the UDF at the object level ([User Defined Fields](https://help.tallysolutions.com/article/DeveloperReference/tdlreference/user_defined_fields.htm)). We have **no** `#Form: Voucher` / **Field** with **`Storage : PESOWISE_METADATA_JSON`** in bootstrap TDL. |
| **Import envelope / tag shape unverified against a golden voucher** | Tally’s integration guidance: populate UDF in UI once, **export that voucher**, reuse **exact** UDF tag hierarchy for imports ([Sample XML](https://help.tallysolutions.com/sample-xml/)). We never had a golden export containing this UDF. |
| **Misread success signal** | **`CREATED=1`** only logs voucher creation; it is **not** UDF acceptance. |

### 3. Is current **`[System : UDF]`** definition sufficient?

**No — not sufficient alone** for proven voucher metadata persistence.

It registers UDF **25001** at system level but does **not**:

- Bind **`Storage : PESOWISE_METADATA_JSON`** on the **Voucher** object (via Form/Field), or
- Prove import XML tag shape TallyPrime 7 accepts for vouchers.

Ledger **`PESOWISE_STABLE_KEY`** success does **not** generalize: masters and vouchers use different import/storage paths.

### 4. Correct TDL (manual — do not auto-apply)

Minimum **additional** manual TDL (keep index **25001** unchanged), conceptually:

1. **`[System : UDF]`** — keep existing line.
2. **Field + Storage on Voucher** — attach UDF to voucher object context (required for “exists on object” per Tally).
3. **Scope to custom type** — show/store only for **`PesoWise Report Meta`** (Journal-based type must exist in company).

Example skeleton (admin must validate syntax in TallyPrime 7 TDL editor before load):

```tdl
[System : UDF]
PESOWISE_METADATA_JSON : String : 25001

[Field : PW Pesowise Metadata JSON]
Use         : Voucher Type : PesoWise Report Meta
Storage     : PESOWISE_METADATA_JSON
Set as      : $PESOWISE_METADATA_JSON
Invisible   : Yes

[#Form : Voucher]
Add : Field : At End : PW Pesowise Metadata JSON
```

Optional: add **`PESOWISE_METADATA_JSON`** to **More Details** / a column later for human verification — not required for Phase 5.1 gate.

**Do not modify loaded TDL automatically** in repo scripts; admin loads/reloads TCP/TDL manually.

### 5. Correct XML representation (production target)

Align with **`serializeMetadata()`** — **no ledger lines**, no fake amounts:

```xml
<TALLYMESSAGE xmlns:UDF="TallyUDF">
  <VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta">
    <DATE>YYYYMMDD</DATE>
    <NARRATION>…unique token…</NARRATION>
    <UDF:PESOWISE_METADATA_JSON TYPE="String">…XML-escaped JSON…</UDF:PESOWISE_METADATA_JSON>
  </VOUCHER>
</TALLYMESSAGE>
```

After first **successful manual export** containing the UDF, **mirror exact** UDF tag form (`TYPE`, **`INDEX="25001"`**, `.LIST` if present) in code — do not guess variants (`_udf-xml-variants.ps1` probes remain unproven).

**Verify persisted type in export:** `VCHTYPE` / `VOUCHERTYPENAME` must read **`PesoWise Report Meta`**, not **Payment**.

**Envelope note (follow-up, not executed here):** Tally samples often import vouchers under report id **`Vouchers`**; our envelope uses **`All Masters`**. Revisit only if type+UDF still fail after TDL Field binding.

### 6. Correct metadata voucher / object design

| Layer | Design |
|-------|--------|
| **Voucher type** | **`PesoWise Report Meta`**, **Journal** parent, manual numbering (existing GUI/repo bootstrap). |
| **Payload** | Single voucher per metadata command; JSON in **`PESOWISE_METADATA_JSON`** per Phase 4 schema. |
| **Accounting** | **Zero ledger lines** — metadata must **not** hit P&L, balance sheet, or synthetic PW-SYNTH ledgers. |
| **Not production** | ±₹1 (or any) **`ALLLEDGERENTRIES.LIST`** on expense ledgers — **rejected** (pollutes books; caused **Payment** persistence). |

If Journal custom type still rejects zero-line vouchers after TDL fix, evaluate **Memorandum**-class non-accounting voucher type (Tally-native) as the **smallest** alternative — only with manual Tally validation, not ledger hacks.

**Separate objects (ledgers, expenses)** remain for real money; metadata vouchers are **report/timeline carriers** only.

### 7. Zero accounting impact — possible?

**Yes, in principle**, if Tally accepts a **Journal-based (or Memorandum) custom voucher** with **no amount lines** and a **persisted voucher UDF** — matching Phase 4 intent.

**No**, via the Phase 5.1 balanced-ledger experiment: export proves **real Payment** with **PW-SYNTH-CAT / PW-SYNTH-EMP** amounts.

### 8. Smallest manual change required

1. **Extend bootstrap TDL** with **Voucher Field + `Storage : PESOWISE_METADATA_JSON`**, scoped to **`PesoWise Report Meta`** (§4 skeleton).
2. **Reload TDL** in TallyPrime; confirm voucher type **PesoWise Report Meta** (Journal) still exists.
3. **Leave voucher #3 unchanged** (already a polluted Payment test artifact).

### 9. Next **one** controlled test (after TDL — do not execute in this task)

**Single new import** using **Phase 4 `serializeMetadata()` shape only** (unique narration token, **no** ledger lines, `VCHTYPE="PesoWise Report Meta"`) → **manual** **Current Voucher → Export → XML** on **that new voucher** only.

**Pass criteria:**

- `VCHTYPE` / `VOUCHERTYPENAME` = **`PesoWise Report Meta`**
- **`UDF:PESOWISE_METADATA_JSON`** (or `.LIST` + **`INDEX="25001"`**) present with exact JSON
- **No** `ALLLEDGERENTRIES` for synthetic metadata test (unless Tally forces none)

**Fail:** stop; no connector pairing, no HTTP bulk readback, no ±1 ledger workaround.

---

## Controlled metadata persistence test (2026-10-06) — one import only

### Manual prerequisite (admin)

- TallyPrime **Release 7.0**, company **`PesoWise Integration Test`**, port **9000**
- Bootstrap TDL v2 loaded (**1 Loaded**, no TDL error):

```tdl
[System : UDF]
PESOWISE_METADATA_JSON : String : 25001

[Field : PW Metadata JSON]
Use       : Name Field
Storage   : PESOWISE_METADATA_JSON
Set As    : $PESOWISE_METADATA_JSON
Invisible : Yes

[#Form : Voucher]
Add : Field : At End : PW Metadata JSON
```

### Pre-import (shell only)

| Check | Result |
|-------|--------|
| `tally.exe` | **running** |
| `127.0.0.1:9000` | **listening** |
| Company loaded | **assumed** (user prerequisite; import targets `SVCURRENTCOMPANY`) |

### Single HTTP action

Script: `scripts/tally-integration/local-tally-metadata-persistence-once.mjs`

**Shape:** Phase 4 metadata — `VCHTYPE=PesoWise Report Meta`, **no** `ALLLEDGERENTRIES.LIST`, `xmlns:UDF`, `UDF:PESOWISE_METADATA_JSON TYPE="String"`, `REPORTNAME=All Masters`.

| Field | Value |
|-------|--------|
| Narration | `Phase51 UDF persistence test PW-META-UDF-001` |
| Date | **20261006** |
| JSON | `schema_version` 1, `roundtrip_token` **PW-META-UDF-001**, `phase` **5.1_controlled_persistence_test** |

### Tally response (complete)

```xml
<RESPONSE>
 <CREATED>0</CREATED>
 <ALTERED>0</ALTERED>
 <DELETED>0</DELETED>
 <LASTVCHID>0</LASTVCHID>
 <LASTMID>0</LASTMID>
 <COMBINED>0</COMBINED>
 <IGNORED>0</IGNORED>
 <ERRORS>0</ERRORS>
 <CANCELLED>0</CANCELLED>
 <EXCEPTIONS>1</EXCEPTIONS>
</RESPONSE>
```

| Metric | Value |
|--------|--------|
| Elapsed | **~81 ms** |
| HTTP | **200** |
| `CREATED` | **0** |
| `ERRORS` | **0** |
| `EXCEPTIONS` | **1** |
| `LINEERROR` | **none** |
| After `tally.exe` / port **9000** | **both up** |

**Classification:** **CONTROLLED TEST FAILED — STOPPED SAFELY** — no retry, no readback, no alternate XML in this gate.

**Note:** TDL Field uses `Use : Name Field` (admin-loaded); diagnostic doc had suggested `Use : Voucher Type : PesoWise Report Meta`. Silent **`EXCEPTIONS=1`** with zero-line Journal meta voucher may still be **voucher structure** (Journal requires lines) and/or **Field/Use** scope — resolve only via Tally-side diagnosis / manual voucher creation test, not another blind import in Phase 5.1.

---

## Controlled voucher import structure test #2 (2026-10-06) — one import

**Change from test #1:** `REPORTNAME=**Vouchers**` (not All Masters); explicit **`VOUCHERTYPENAME`**, **`PERSISTEDVIEW`**, **`ISINVOICE`**, **`OBJVIEW`** on voucher. **TDL not modified.**

Script: `scripts/tally-integration/local-tally-metadata-persistence-vouchers-report-once.mjs`

| Field | Value |
|-------|--------|
| Narration | `Phase51 UDF persistence test PW-META-UDF-002` |
| `roundtrip_token` | **PW-META-UDF-002** |
| Date | **20261006** |
| Ledger / inventory / amounts | **none** |

### Tally response (complete)

```xml
<RESPONSE>
 <CREATED>0</CREATED>
 <ALTERED>0</ALTERED>
 <DELETED>0</DELETED>
 <LASTVCHID>0</LASTVCHID>
 <LASTMID>0</LASTMID>
 <COMBINED>0</COMBINED>
 <IGNORED>0</IGNORED>
 <ERRORS>0</ERRORS>
 <CANCELLED>0</CANCELLED>
 <EXCEPTIONS>1</EXCEPTIONS>
</RESPONSE>
```

| Metric | Value |
|--------|--------|
| Elapsed | **~72 ms** |
| HTTP | **200** |
| After `tally.exe` / port **9000** | **both up** |
| `LINEERROR` | **none** |

**Classification:** **CONTROLLED VOUCHER STRUCTURE TEST FAILED — STOPPED SAFELY** — same silent exception as test #1; **`REPORTNAME` + view tags alone did not unlock zero-line `PesoWise Report Meta` import.**

---

## Controlled test #3 — voucher type config fix (2026-10-06)

### Manual Tally prerequisite (admin)

**PesoWise Report Meta** voucher type settings corrected:

| Setting | Now |
|---------|-----|
| Type of voucher | **Journal** |
| Activate this Voucher Type | **Yes** (was No) |
| Method of Voucher Numbering | **Manual** |
| Allow zero-valued transactions | **Yes** (was No) |
| Allow narration in voucher | **Yes** |

TDL unchanged (still loaded).

Script: `scripts/tally-integration/local-tally-metadata-persistence-test3-once.mjs`

| Field | Value |
|-------|--------|
| `REPORTNAME` | **Vouchers** |
| `VOUCHERNUMBER` | **PW-META-003** |
| Narration | `Phase51 UDF persistence test PW-META-UDF-003` |
| `roundtrip_token` | **PW-META-UDF-003** |
| Ledger / amounts | **none** |

### Tally response (complete)

```xml
<RESPONSE>
 <CREATED>0</CREATED>
 <ALTERED>0</ALTERED>
 <DELETED>0</DELETED>
 <LASTVCHID>0</LASTVCHID>
 <LASTMID>0</LASTMID>
 <COMBINED>0</COMBINED>
 <IGNORED>0</IGNORED>
 <ERRORS>0</ERRORS>
 <CANCELLED>0</CANCELLED>
 <EXCEPTIONS>1</EXCEPTIONS>
</RESPONSE>
```

| Metric | Value |
|--------|--------|
| Elapsed | **~115 ms** |
| HTTP | **200** |
| After `tally.exe` / port **9000** | **both up** |
| `LINEERROR` | **none** |

**Classification:** **CONTROLLED TEST #3 FAILED — STOPPED SAFELY** — activating the type and allowing zero-valued transactions did **not** change import outcome; silent **`EXCEPTIONS=1`** persists.

**Manual UI confirmation:** Even with **Allow zero-valued transactions = Yes**, **Ctrl+A** does **not** save a **PesoWise Report Meta** voucher with **no** accounting lines — Tally keeps focus in the accounting-entry grid. Therefore **zero-valued ≠ zero ledger lines**.

---

## PESOWISE TALLY PERSISTENCE ARCHITECTURE DECISION

**Status: LEDGER METADATA PATH VALIDATED IN REAL TALLY (manual + HTTP create); voucher metadata path rejected**  
**Static diagnostic only** — no imports, no port 9000, no TDL/data changes in this step.

### Executive summary

| Track | Purpose | Persistence object |
|-------|---------|------------------|
| **Accounting** | Real money (expenses, balance events) | **`PesoWise Expense` / `PesoWise Balance` vouchers** (unchanged Phase 4 intent) |
| **Report read-model** | CV / CA / Detailed / Daily TDL data | **NOT** a Journal metadata voucher — recommend **dedicated Ledger masters** as metadata carriers |

### 1. Root cause — current Journal / metadata-voucher approach

| Factor | Evidence |
|--------|----------|
| **Accounting voucher invariant** | Tests #1–#3: metadata-only **Voucher** XML → **`EXCEPTIONS=1`**, **`CREATED=0`** regardless of `All Masters` vs **`Vouchers`**, view tags, manual **VOUCHERNUMBER**, type **Active**, **Allow zero-valued = Yes**. |
| **UI confirms import rule** | Manual **PesoWise Report Meta**: cannot save without completing the **accounting entry** workflow; **Allow zero-valued transactions** permits **0.00 on lines**, not **absence of lines**. |
| **Tally import model** | [Sample XML / voucher prerequisites](https://help.tallysolutions.com/sample-xml/): vouchers expect balanced **Dr/Cr** structure; integration **`Import : Vouchers`** runs voucher business logic ([Import File](https://help.tallysolutions.com/how-to-use-import-file-definition-and-related-events/)). |
| **Wrong success signal (historical)** | Balanced ±₹1 test: **`CREATED=1`** but persisted **Payment** + ledgers, **no UDF** in Data Interchange export — not metadata success. |
| **TDL gap (secondary)** | Current Field uses **`Use : Name Field`** on **Voucher** form; even perfect voucher import would still need voucher-appropriate **Storage** binding — but **primary blocker is zero-line voucher rejection**. |

**Conclusion:** Phase 4’s **`PesoWise Report Meta` voucher + UDF** design conflicts with TallyPrime 7 **accounting voucher mechanics**. Report metadata should **not** be modeled as a zero-line Journal voucher.

### 2. Recommended persistence object (report metadata)

**Primary recommendation: one Ledger master per PesoWise metadata record** (read-model), in a dedicated group **`PesoWise Metadata`** (or equivalent), **never referenced** in any voucher line.

| Why Ledger master |
|-------------------|
| **Proven in Phase 5.1:** `All Masters` + **`LEDGER`** + **`UDF:PESOWISE_STABLE_KEY`** → **`CREATED=1`** (master UDF path works). |
| **No voucher lines** required — no Day Book / P&L posting from metadata CREATE. |
| **Stable idempotency:** map `{org}:meta:{report}:{source_key}` → deterministic ledger name + **`PESOWISE_STABLE_KEY`** / JSON UDF (same pattern as employee/category masters). |
| **TDL Collections:** `TYPE Ledger` + `FILTER` on group/name prefix + `FETCH` `$PESOWISE_METADATA_JSON` (parse JSON in report TDL). |
| **Survives restart:** masters live in company `.900` data (same as all Tally persistence). |

**One object per PesoWise stable key:** `reportMetadataDeliveryKey()` in `src/lib/tallyMapping/identities.ts` already defines `{org}:meta:{reportType}:{sourceKey}` — use as **`PESOWISE_STABLE_KEY`** + human-readable ledger name.

### 3. Why safer than metadata Journal vouchers

| Metadata Journal voucher | Metadata Ledger master |
|--------------------------|-------------------------|
| Requires accounting grid / lines for save & import | Master CREATE/ALTER only |
| Appears in **Day Book** if mis-typed (Payment pollution proved) | **No** voucher → **no** Day Book / registers |
| **`EXCEPTIONS=1`** on all controlled zero-line imports | **`All Masters`** path already green for ledger+UDF |
| Conflates accounting + read-model | **Separates** real **`PesoWise Expense`** from report payload |

### 4. Role of UDF

| UDF | Role |
|-----|------|
| **`PESOWISE_METADATA_JSON`** (String **25001**) | Canonical **JSON blob** (`PesowiseTallyMetadataV1`) for TDL report rendering — parse `schema_version`, `report_type`, `fields`, `accounting_key`, etc. |
| **`PESOWISE_STABLE_KEY`** (existing on masters) | Deterministic **delivery/idempotency** key; duplicate detection; ALTER vs SKIP. |

**TDL change (future, not applied now):** move **`Storage : PESOWISE_METADATA_JSON`** from **Voucher** form to **`#Form : Ledger`** (or duplicate Field definitions on both if ever needed). Current voucher Field does not help ledger path.

### 5. TDL components eventually required (proposed)

1. **`[System : UDF]`** — keep **`PESOWISE_METADATA_JSON : String : 25001`** (+ existing stable key UDF if separate).
2. **`[Field : PW Metadata JSON]`** on **Ledger** with **`Storage : PESOWISE_METADATA_JSON`** (and optional **`Use : Group : PesoWise Metadata`**).
3. **`[#Form : Ledger]`** — Add Field (invisible or admin-only).
4. **Report menu** — `Report : PesoWise Reports` → four sub-reports.
5. **Collections** — e.g. `PW CV Metadata Coll` : `TYPE Ledger`, `FILTER` group/name, `FETCH` Name, `$PESOWISE_METADATA_JSON`, `$PESOWISE_STABLE_KEY`.
6. **JSON parse** in TDL — branch on `$PESOWISE_METADATA_JSON` / `report_type` (Phase 4 contract).

### 6. XML/API concept — CREATE (proposed)

- **Envelope:** `TALLYREQUEST=Import Data`, **`REPORTNAME=All Masters`** (proven).
- **Message:**

```xml
<TALLYMESSAGE xmlns:UDF="TallyUDF">
  <LEDGER ACTION="Create">
    <NAME.LIST><NAME>PW-META …</NAME></NAME.LIST>
    <PARENT>PesoWise Metadata</PARENT>
    <UDF:PESOWISE_STABLE_KEY TYPE="String">{delivery_key}</UDF:PESOWISE_STABLE_KEY>
    <UDF:PESOWISE_METADATA_JSON TYPE="String">{escaped JSON}</UDF:PESOWISE_METADATA_JSON>
  </LEDGER>
</TALLYMESSAGE>
```

Golden tag hierarchy must be taken from **first successful manual ledger export** (Tally rule).

### 7. UPDATE / idempotency (proposed)

| Step | Behavior |
|------|----------|
| **Key** | `reportMetadataDeliveryKey(org, reportType, sourceKey)` → `tally_delivery_state.delivery_key` (Phase 4 already). |
| **SKIP** | Same `content_hash` as last ack → no XML. |
| **CREATE** | `LEDGER ACTION=Create` if no `tally_remote_id` / name absent. |
| **UPDATE** | `LEDGER ACTION=Alter` with new JSON when hash changes; identify by **Master ID** or **Name** from prior ack. |
| **Link to accounting** | Optional `accounting_key` inside JSON points to **`PesoWise Expense`** voucher — no duplicate expense posting. |

### 8. How TDL reports read data (proposed)

- Menu: **PesoWise Reports** → Claim Verification / Claim Approval / Detailed Expense / Daily Project.
- Each report: **Collection** over **`PesoWise Metadata`** ledgers (or FILTER `$PESOWISE_METADATA_JSON` contains `"report_type":"claim_verification"` etc.).
- **Walk** collection → parse JSON → render columns (workflow, custom fields, balances from JSON — Phase 1 audit fields).
- Join logic to accounting (if needed): match `accounting_key` / `expense_id` in JSON to **`PESOWISE_ACCOUNTING_KEY`** on expense vouchers — **read-only** in TDL, not double posting.

### 9. Accounting / financial impact

| Object | P&L / Balance Sheet | Day Book |
|--------|---------------------|----------|
| **Metadata ledger** (never in vouchers) | **None** | **None** |
| **`PesoWise Expense` / Balance** | Real amounts only | Appears when legitimately posted |

**Rejected permanently:** synthetic ±₹1 (or any) lines for metadata.

### 10. Restart persistence

All **Ledger** masters and UDF values are stored in the **company data file** — survive Tally exit, Windows restart, and TDL reload (UDF **definition** must remain loaded for labels; **INDEX** in export survives per [Tally FAQ 9242](https://help.tallysolutions.com/article/DeveloperReference/faq/9242.html)).

### 11. TallyPrime 7.0 compatibility

| Area | Risk |
|------|------|
| **Ledger + UDF import** | **Low** — demonstrated **`PESOWISE_STABLE_KEY`**. |
| **Metadata JSON size** | **Medium** — String UDF **25001**; large daily rows may need size check / compression policy. |
| **Journal metadata voucher** | **High / blocked** — do not use until Tally documents zero-line import (none seen). |
| **Memorandum** | **Unvalidated** — see options matrix below. |

### 12. Migration impact — Phase 4 / 5 code

| Component | Change (when implemented) |
|-----------|----------------------------|
| `serializeMetadata()` | Emit **`LEDGER`** not **`VOUCHER`**; `REPORTNAME=All Masters`. |
| `TallyCommand` | `report_metadata` → master-shaped serializer (or new `kind: "metadata_ledger"`). |
| `mapPreparedItem.ts` | Logic unchanged; only XML target changes. |
| Bootstrap scripts | Create group **`PesoWise Metadata`**; **deprecate** bootstrap **`PesoWise Report Meta`** voucher type for metadata (optional keep for legacy). |
| Connector / delivery ack | Ack **Master ID** / ledger name instead of `LASTVCHID` for metadata kind. |
| Phase 5.1 tests | Replace voucher metadata imports with **one** ledger metadata golden test. |
| Docs Phase 4 §16 | Update mechanism description when validated. |

### 13. Legitimate PesoWise expense vouchers

**Unchanged role:** **`PesoWise Expense`** (and **`PesoWise Balance`**) remain the **only** XML paths that move money. Metadata ledgers **reference** expenses via JSON (`accounting_key`, `expense_id`) for TDL joins — they do **not** replace or duplicate expense vouchers. Cross-report dedup (`AccountingRegistry`) stays as-is.

### 14. Smallest next manual test (proposed)

1. In Tally: create group **`PesoWise Metadata`** (if missing).
2. Create **one** ledger **`PW-META-MANUAL-001`** under that group (opening balance **0**).
3. If UDF visible on ledger: paste minimal JSON; else rely on next import after **Ledger** Field TDL fix.
4. **Export → XML** that **ledger only** (Data Interchange).
5. Confirm export contains **`UDF:PESOWISE_METADATA_JSON`** (or `.LIST` + **`INDEX="25001"`**).
6. **Only then** — one controlled **`All Masters`** HTTP import mirroring that export shape (future gate; **not** in this task).

---

### Options matrix (static evaluation)

| Option | XML CREATE/UPDATE | Persists in company | TDL Collection read | Accounting impact | Ledger lines required | One per stable key | String UDF JSON | TP7 notes |
|--------|-------------------|---------------------|---------------------|-------------------|----------------------|--------------------|-----------------|-----------|
| **A. Voucher UDF (Journal meta)** | Theoretically | Yes | Voucher coll. (risky) | **Risk** if lines added | **Yes** (proved) | Yes | Yes | **Blocked** — tests #1–#3 + UI |
| **B. Memorandum voucher** | Maybe | Yes | Voucher coll. | Lower than Payment; **not zero** | Likely **yes** (0.00 lines) | Yes | Yes | **Unvalidated**; still vouchers/registers; does not fix zero-line import without lines |
| **C. Custom TDL object** | No native store | N/A | Custom | N/A | N/A | N/A | N/A | Not a standard persistence tier |
| **D. UDF on master (Ledger)** | **Yes** (`All Masters`) | **Yes** | **Ledger** coll. | **None** if unused in vouchers | **No** | **Yes** | **Yes** | **Recommended** — STABLE_KEY proved |
| **E. Cost Centre UDF** | Yes (masters) | Yes | Cost Centre coll. | None | No | Yes for project rows | Yes | Partial — awkward for CV/CA expense rows |
| **F. UDF on expense voucher only** | Alter voucher | Yes | Voucher | None extra if ALTER only | Expense already has lines | Per expense only | Yes | **Insufficient** for daily-only / non-voucher rows |
| **G. Optional / ISOPTIONAL voucher** | Unknown | Yes? | Voucher | Unclear | Unknown | Yes | Yes | **Not validated**; still voucher path |

**Memorandum verdict:** Not recommended as default — it remains a **voucher** (register visibility, likely **requires** ledger rows including 0.00 with `REMOVEZEROENTRIES`), and we have **no** TP7 proof it accepts metadata-only XML. It does **not** clearly beat **metadata Ledger** on safety or import evidence.

---

## Ledger UDF UI attachment diagnostic (2026-10-06) — static only

**Goal:** Make **one visible** UDF-backed string field appear on **Ledger Creation / Alteration** in TallyPrime 7.0.  
**Real Tally result (user):** TDL compiles; **Create → Ledger** for **`PW-META-MANUAL-001`** under **`PesoWise Metadata`** shows **no** “PW Metadata JSON” field; ledger **not saved**.

### Loaded TDL (user — compiles)

```tdl
[System : UDF]
PESOWISE_METADATA_JSON : String : 25001

[Field : PW Metadata JSON]
Use       : Name Field
Storage   : PESOWISE_METADATA_JSON
Set As    : $PESOWISE_METADATA_JSON
Width     : 80
Max       : 1000

[#Form : Ledger]
Add : Field : At End : PW Metadata JSON
```

### 1. Why `#Form : Ledger` / `Add : Field` did not display

| Issue | Explanation |
|-------|-------------|
| **Wrong UI hierarchy** | Tally screens are **Form → Part → Line → Field**. Adding a **Field** directly to a **Form** (without a **Line** on a **Part**) is not the supported ledger-master pattern; the runtime often **ignores** orphan form-level field adds. |
| **Wrong form target** | Ledger **creation** is driven by reports/forms such as **`Create Ledger`** / master wizards, not necessarily a form literally named **`Ledger`**. Community + Tally UI docs attach UDFs to **`#Part : Led Other Details`**, which is embedded in create/alter flows ([TallyNine ledger UDF pattern](https://tallynine.com/learn-tdl-how-to-create-a-new-field-in-ledger-master/), [TDLExperts](http://tallytdlexperts.blogspot.com/2011/10/udf-in-ledger-creation.html)). |
| **`Use : Name Field` + `Set As : $…`** | **`Name Field`** is the template for **ledger name** entry (method **`Name`**). Pairing it with **`Set As : $PESOWISE_METADATA_JSON`** makes the control behave like a **bound display** of the UDF, not a standard blank input line — can suppress or misplace UI on create. |
| **`Set As` on an input UDF** | For **user entry**, Tally expects **`Storage : UDFName`** only; **`Set As`** is for **display/computed** values. Editable storage fields typically **omit `Set As`**. |
| **Section visibility** | Even a correct line appears under **Other Details** (often **below** name/group, address, GST) — not on the first name screen; user may need to **Page Down** / expand **More details**. |

### 2. Minimal TDL replacement — **PROPOSED — NOT YET REAL-TALLY VALIDATED**

Replace the **`[Field …]` + `[#Form : Ledger]`** block with **Part + Line + Field** (keep **`[System : UDF]`** unchanged):

```tdl
[System : UDF]
PESOWISE_METADATA_JSON : String : 25001

[#Part : Led Other Details]
Add : Line : PW Meta JSON Line

[Line : PW Meta JSON Line]
Fields : Short Prompt, PW Metadata JSON
Local : Field : Short Prompt : Info : "PesoWise metadata :"

[Field : PW Metadata JSON]
Use     : Name Field
Storage : PESOWISE_METADATA_JSON
Width   : 80
```

**Optional (if `Name Field` still misbehaves in TP7):** swap only the field template:

```tdl
[Field : PW Metadata JSON]
Use     : Short Name Field
Storage : PESOWISE_METADATA_JSON
Width   : 80
```

Do **not** add `Set As`, `Max`, or `Invisible` for the first visibility test.

### 3. Attachment levels used (proposed)

| Level | Name | Role |
|-------|------|------|
| **System** | `[System : UDF]` | Declares storage slot **25001** / name **`PESOWISE_METADATA_JSON`**. |
| **Part (modify)** | `[#Part : Led Other Details]` | Hooks into Tally’s existing **ledger supplementary** area used in create/alter. |
| **Line (add)** | `[Line : PW Meta JSON Line]` | One row: label + input. |
| **Field (local)** | `Short Prompt` | Label via **`Local : Info`**. |
| **Field (custom)** | `PW Metadata JSON` | **`Storage`** binds typed text to ledger object UDF. |

Not used: **`#Form : Ledger`**, **`Add : Field : At End`** (form-level).

### 4. `Set As` — remove for editable stored field

**Yes — remove.** Use **`Storage : PESOWISE_METADATA_JSON`** only so keystrokes persist to the ledger object. Use **`Set As`** later only for **read-only** display lines in reports.

### 5. Is `Use : Name Field` appropriate?

**Marginal / often wrong for custom JSON.** It reuses the **name-entry** keyboard/table behavior. Prefer **`Use : Short Name Field`** (common in ledger UDF examples) or a plain **String** field with **`Storage`** for a free-text JSON line. **`Name Field`** is **not** “attach to name column”; it is a **UI template**.

### 6. TP7-specific notes

- Part name must match shipped definition: try **`Led Other Details`** first; if still missing, use **Tally’s Definition editor / Script** (if licensed) to confirm exact part name in your build (spacing/case).
- **Release 7** GST/statutory blocks may push “other” lines lower — scroll / **More details**.
- **`Max : 1000`** on the prior field could truncate JSON tests — omit until visibility works.
- Compilation **without error** does not prove **modify target exists** — silent no-op if part/form name mismatches.

### 7. Manual steps to replace / reload TDL (user)

1. Edit the **same** local `.tdl` / `.tcp` source (do not auto-edit from repo).
2. Keep **`[System : UDF]`**; replace Form-level add with **`#Part : Led Other Details`** block above.
3. **Save** file; in Tally **F12 → Product & Features → Tally Development Zone** (or your usual **Load TDL** path) → **reload** the file → confirm **loaded, no errors**.
4. **Restart Tally** or re-open company if fields still cached.
5. **Create → Ledger** → name **`PW-META-MANUAL-001`**, under **`PesoWise Metadata`** → look under **Other details** / scroll down.

### 8. Expected visual result

- A labeled row **`PesoWise metadata :`** with an **empty editable** text box on ledger create/alter (in **Other Details** area).
- After accept/save, altering the ledger should **show the same value**; Data Interchange export of that ledger should eventually include **`UDF:PESOWISE_METADATA_JSON`** (validation is a **later** gate).

### 9. ONE next manual test only

After reload: create **`PW-META-MANUAL-001`**, type **`{"probe":true}`** in the new box, **save** → **Alter** the ledger → confirm text persisted → **Export** that ledger to XML and check for UDF tag. **No HTTP import** in this step.

---

## Real Tally ledger metadata persistence (2026-10-06)

| Gate | Status |
|------|--------|
| **MANUAL LEDGER UDF PERSISTENCE** | **PASS** (TallyPrime **7.1**, company **PesoWise Integration Test**) |
| **AUTOMATED LEDGER IMPORT (HTTP)** | **PASS** — one-shot **`All Masters`** create **PW-META-HTTP-001**; manual Alter/export confirmation **pending** |
| **Metadata Journal voucher path** | **REJECTED** — do not continue |

### Manual ground truth — **PW-META-MANUAL-001** (do not modify)

- Group: **PesoWise Metadata**
- UDF value: `{"probe":true,"token":"PW-META-MANUAL-001"}`
- Data Interchange export shape:

```xml
<UDF:PESOWISE_METADATA_JSON.LIST
    DESC="`PESOWISE_METADATA_JSON`"
    ISLIST="YES"
    TYPE="String"
    INDEX="25001">
  <UDF:PESOWISE_METADATA_JSON DESC="`PESOWISE_METADATA_JSON`">
    …JSON…
  </UDF:PESOWISE_METADATA_JSON>
</UDF:PESOWISE_METADATA_JSON.LIST>
```

### Controlled HTTP ledger import — **PW-META-HTTP-001** (one request)

Script: `scripts/tally-integration/local-tally-metadata-ledger-import-once.mjs`

| Item | Value |
|------|--------|
| `REPORTNAME` | **All Masters** |
| Ledger | **PW-META-HTTP-001** |
| `PARENT` | **PesoWise Metadata** |
| UDF JSON | `{"probe":true,"token":"PW-META-HTTP-001","source":"phase51_http_import"}` |
| UDF XML | **`.LIST` + nested tag + `INDEX="25001"`** (golden shape; import used `DESC="PESOWISE_METADATA_JSON"`) |
| Voucher / opening balance | **none** |

**Response:**

```xml
<RESPONSE>
 <CREATED>1</CREATED>
 <ALTERED>0</ALTERED>
 <ERRORS>0</ERRORS>
 <EXCEPTIONS>0</EXCEPTIONS>
 …
</RESPONSE>
```

| Metric | Value |
|--------|--------|
| Elapsed | **~123 ms** |
| Before/after `tally.exe` + **9000** | **up / up** |

**Automated gate:** **PASS** — no retry, no readback.

**User manual follow-up (required for full round-trip):** Alter **PW-META-HTTP-001** → confirm UDF field JSON → **Masters → Ledgers → Export XML** → verify **`INDEX="25001"`** and **`token":"PW-META-HTTP-001"`**.

---

### Pairing / connector run / E2E / idempotency / restart / offline

**Not executed** — blocked on metadata round-trip + admin sign-in + pairing code.

### Parser hardening

`parseTallyImportResponse` now uses numeric `CREATED`/`ALTERED` values and treats `EXCEPTIONS>0` as failure (+ regression test). **162** tally-scoped tests pass.

### Tally service note

During session, Tally integration port briefly returned **ECONNREFUSED** — ensure TallyPrime is open on **`PesoWise Integration Test`** with integration **:9000** enabled before re-running micro tests or connector `run`.

---

## Summary (historical — pre-server-deploy attempt)

| Area | Result |
|------|--------|
| Backend deploy to `.46` (first attempt) | SSH timeout from Tally-only network |
| Test company (first attempt) | Missing |
| EXE (first attempt) | pkg snapshot broken |

---

## Files changed (Tally-side session)

- `connector/tally/tsconfig.json` — CommonJS for pkg
- `connector/tally/package.json` — `main`, removed `"type":"module"`
- `connector/tally/scripts/build-win-exe.mjs` — entry `dist/main.js`
- `connector/tally/src/responseParser.ts` + `src/lib/tallyConnector/responseParser.ts`
- `scripts/tally-integration/local-tally-micro-test.mjs` — bootstrap + master UDF
- `scripts/tally-integration/tally-phase51-backend-setup.mjs` — admin pairing + smoke isolation (env-gated)
- `scripts/tally-integration/local-tally-safe-single-voucher-readback-once.mjs` — bounded Object export (one-shot gate)
- `scripts/tally-integration/local-tally-targeted-voucher-lookup-once.mjs` — inline filtered collection identity probe (one-shot)
- `scripts/tally-integration/local-tally-metadata-persistence-once.mjs` — TDL v2 controlled metadata import (one-shot, All Masters)
- `scripts/tally-integration/local-tally-metadata-persistence-vouchers-report-once.mjs` — structure test #2 (Vouchers report)
- `scripts/tally-integration/local-tally-metadata-persistence-test3-once.mjs` — test #3 (activated + zero-valued + VOUCHERNUMBER)
- `scripts/tally-integration/local-tally-metadata-ledger-import-once.mjs` — golden UDF `.LIST` ledger HTTP import (one-shot)
- `src/lib/__tests__/tallyConnectorPhase5.test.ts` — EXCEPTIONS regression

---

## Immediate manual actions

1. **Architecture (proposed):** Follow § **PESOWISE TALLY PERSISTENCE ARCHITECTURE DECISION** — **metadata Ledger** path, not Journal voucher imports.
2. **Smallest manual test:** §14 — create **`PW-META-MANUAL-001`** ledger under **`PesoWise Metadata`**, export ledger XML, confirm UDF shape.
3. **Do not** pair connector, run smoke batches, or backend E2E until ledger metadata persistence is **validated in real Tally**.

---

## Phase 6 readiness

**NOT READY** — metadata UDF not proven; no pairing/E2E/idempotency pass.
