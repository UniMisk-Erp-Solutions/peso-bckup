# Incident — TallyPrime c0000005 during Agent doctor

**Date:** 2026-10-06  
**Status:** Live Tally HTTP testing **STOPPED** until a validated passive probe exists.

## Environment

| Item | Value |
|------|--------|
| Tally | TallyPrime **Release 7.1** |
| Company (GUI) | **PesoWise Integration Test** |
| Period | 1-Apr-26 to 31-Mar-27 |
| Integration | TallyPrime acts as **Server**, **ODBC** enabled, port **9000** |

## Symptom

While **`PesoWise-Tally-Agent.exe doctor`** was running:

- Doctor **hung** (blinking cursor in terminal).
- TallyPrime then showed **Internal Error — Contact Tally Solutions**.
- **Software Exception c0000005** (Memory Access Violation / APPCRASH).

No intentional accounting writes (vouchers/masters/metadata import) were part of doctor; the failure occurred during **automated XML probes** to `http://127.0.0.1:9000`.

## Doctor sequence before fix (unsafe)

When `tally_company` was set and `tally_localhost` was true, `TallyClient.verifyCompany()` ran **in order**:

1. **HTTP POST** `http://127.0.0.1:9000`  
   **Object export** — `TALLYREQUEST=Export`, `TYPE=Object`, `SUBTYPE=Company`, `ID TYPE="Name"` = configured name, **`SVCURRENTCOMPANY`** = same name.  
   Timeout **15s**. Header: `Content-Type: text/xml;charset=utf-8`.

2. **HTTP POST** (same URL)  
   **Voucher Type collection export** with **`SVCURRENTCOMPANY`**.  
   Timeout **15s**.

3. If step 1–2 did not verify: **`Load Company`** request  
   `TALLYREQUEST=Load Company` + **`SVCURRENTCOMPANY`**.  
   Timeout **30s**.

4. **Repeat** steps 1–2 after Load Company.

Earlier in the same session, **`doctor`** also used a minimal **Export** envelope for reachability (`isReachable` HTTP POST).

**Prior live probes** (same day) showed empty Company/Voucher Type collections and `Could not find Company:PesoWise Integration Test!` on Object export before Load — making step 3 the likely path when the hang/crash occurred.

## Suspected trigger

**`Load Company`** via integration HTTP is a **state-changing session bind**, not a passive read. On TallyPrime 7.1 it is the **highest-risk** step in the chain (30s timeout, no retry cap in UX, GUI company already loaded). Combined with **Object export by name** and **SVCURRENTCOMPANY** scoped exports, this matches earlier **c0000005** experiments during Phase 5.1 XML probing.

**Accounting data:** No deliberate Import / voucher create / master alter was sent by doctor; risk was **process crash**, not ledger mutation.

## Response (code)

- **Doctor:** TCP **`127.0.0.1:9000` only** (3s, one connect, no retry). Backend heartbeat. Company name from **paired config only**. `tally_company_found` **false**; `tally_company_verification: disabled_pending_safe_probe`.
- **No** `Load Company`, **no** Object/Voucher Type/catalog XML in doctor.
- **Service loop:** removed `verifyCompany`; idle check uses **TCP only**. Import XML only on **claimed delivery**.
- **Scripts:** `_doctor-*-live.mjs` **blocked** unless `ALLOW_LIVE_TALLY=1` (default exit 99).
- **E2E:** never starts `tally.exe`.

See also: `DOCTOR-COMPANY-DETECTION.md` (superseded unsafe section).

## Evidence preserved

- Quarantine / queue / pairing / MicroLink state unchanged.
- Offline regression: `tallyDoctorSafety.test.ts`.

## Next safe test (proposal only — do not run from CI/agent)

**Human-only, after Tally stable:** single manual **TCP** connect to `127.0.0.1:9000` (e.g. PowerShell `Test-NetConnection`) — **no HTTP body**. Then run rebuilt **`doctor`** once and confirm JSON shows `tally_localhost: true`, `tally_company_verification: disabled_pending_safe_probe`, and **no Tally hang**.
