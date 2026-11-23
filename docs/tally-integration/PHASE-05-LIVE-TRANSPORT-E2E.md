# Phase 5 — Live transport E2E validation log

**Date:** 2026-10-06  
**TallyPrime:** 7.1  
**Company:** PesoWise Integration Test only  

| Step | Result |
|------|--------|
| 0 Safety precheck | **PASS** — `tally.exe` up, `:9000` up (initial); connector EXE **not** running |
| 1 ALTER (Test C) | **REAL TALLY NOT PASS** — post-restart single HTTP: `EXCEPTIONS=1` (minimal Alter) — **HARD STOP** |
| 2 Quarantine smoke batches | **NOT EXECUTED** — blocked on Step 1 pass + missing admin/SSH env in session |
| 3 Connector EXE | **PASS** — rebuilt `connector/tally/dist/PesoWise-Tally-Connector.exe` |
| 4 Live pairing | **NOT RUN** — `TALLY_VALIDATE_ADMIN_*` not in environment |
| 5 New controlled sync job | **NOT RUN** |
| 6 Connector E2E | **NOT VALIDATED** |
| 7 Persistence (post-E2E) | **NOT RUN** |
| 8 Accounting voucher (real) | **NOT RUN** |
| 9 Four-report automated | **AUTOMATED PASS** — 198 tests |
| 10 Offline/retry | **AUTOMATED PASS** (migration + unit tests) |
| 11 Test suite | **198 passed** |

**E2E product gate:** **NOT PASS** — connector claim → Tally → ACK not completed.

---

## §1 — ALTER (Test C)

**Script:** `scripts/tally-integration/phase53-test-c-alter.ts`  
**Ledger:** `PW-META-04fd0f3a4fa1` (unchanged)

### Attempt A (minimal Alter XML not yet deployed)

- Response: `CREATED=0`, `ALTERED=0`, `ERRORS=0`, **`EXCEPTIONS=1`**
- Alter XML included `PARENT` + `UDF:PESOWISE_STABLE_KEY`

### Code fix (same session, not yet re-validated on Tally)

`serializeMetadataLedger`: on **`action === "alter"`**, emit **only** `NAME.LIST` + `PESOWISE_METADATA_JSON` UDF list (omit `PARENT` and `PESOWISE_STABLE_KEY`). Rationale: TallyPrime 7.1 Create accepts full shape; Alter often exceptions when re-sending parent/extra UDFs.

### Attempt B (minimal Alter, Tally restarted)

- **78 ms** — `CREATED=0`, `ALTERED=0`, `ERRORS=0`, **`EXCEPTIONS=1`**
- **No further Tally HTTP** (hard stop per runbook).

### CREATE vs ALTER (production serializer)

| Element | CREATE (PASS) | ALTER (FAIL) |
|---------|---------------|--------------|
| `ACTION` | Create | Alter |
| `PARENT` | PesoWise Metadata | omitted |
| `UDF:PESOWISE_STABLE_KEY` | present | omitted |
| UDF JSON | initial hash / remarks | updated hash / `phase53-test-c-controlled-alter` |

**Code path:** `mapPreparedJobItems` → `decideDelivery=update` → `serializeMetadataLedger` in `src/lib/tallyMapping/xml/serialize.ts` (local diff: `phase53-print-create-vs-alter-xml.ts`, no HTTP).

**Hypothesis (unverified):** TallyPrime 7.1 may accept **Create** for ledger UDF index 25001 but reject **Alter** via `All Masters` import without `LINEERROR` detail — requires Tally-side investigation (manual Alter in UI, or Tally API doc), not blind XML retries.

### Manual checkpoint after a successful ALTER

1. Open ledger **`PW-META-04fd0f3a4fa1`** → Alter.
2. UDF **`PESOWISE_METADATA_JSON`**: `remarks` = **`phase53-test-c-controlled-alter`**, `content_hash` = `41e31f2dfb0c5a2381bd62a38cdb57306150baccb8779d0ae4eb579af11b0d2c`.

### Authorized next single HTTP

After Tally is responsive (restart if needed):

```text
npm.cmd exec --yes tsx -- scripts/tally-integration/phase53-test-c-alter.ts
```

Expect: `ALTERED=1`, `EXCEPTIONS=0`.

---

## §2 — Quarantine (pending)

**2026-10-06:** Seven smoke-org pending batches quarantined (`skipped`, audit preserved). Global pending batches = **0**. Scripts: `ssh-quarantine-smoke-batches-transaction.mjs` (fixed base64 psql transport).

## §2b — Quarantine (historical notes)

**Migration (repo only until applied):** `20261007140000_tally_quarantine_smoke_batches.sql`  
**Apply script:** `scripts/tally-integration/apply-quarantine-migration-only.mjs` (`DEPLOY_SSH_PASSWORD`)  
**List/quarantine:** `scripts/tally-integration/list-and-quarantine-smoke-batches.mjs`

**Expected smoke signature:** org `80ab039f-f9e2-4c76-8b5b-e65b15d66af9`, jobs `waiting_for_connector`, ~**168** prepared items, ~**7** pending batches (Phase 5 pre-ledger pivot).

**Batch UUIDs:** record from dry-run JSON when admin creds available.

---

## §3 — Connector EXE

- Path: `connector/tally/dist/PesoWise-Tally-Connector.exe`
- Rebuilt successfully (pkg GZip, Node not required on target machine).
- Scheduled Task install: **not** performed.

---

## §4–8 — Blocked on ALTER + credentials

Provide in shell (do not commit):

- `TALLY_VALIDATE_ADMIN_EMAIL` / `TALLY_VALIDATE_ADMIN_PASSWORD`
- Optional: `DEPLOY_SSH_PASSWORD` for quarantine migration only

Then: dry-run quarantine → confirm IDs → `QUARANTINE_CONFIRM=1` → pairing → one new `daily_project_report` (or smallest) sync → connector service loop once.

---

## Confirmations

- **No TDL/TCP** edited.
- **No unrelated production app deploy.**
- **No bulk production data** imported.
- **No fake ₹1 metadata entries.**
