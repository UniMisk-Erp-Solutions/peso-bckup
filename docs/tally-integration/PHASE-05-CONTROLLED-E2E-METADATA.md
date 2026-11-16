# Phase 5 — Controlled single metadata E2E (first live run)

**Status:** Offline **GO** (2026-10-06): code, **259** tally-related tests, EXEs rebuilt. **Live E2E NO-GO** until migration + queue_safe on backup.  
**Live Tally:** not exercised by this document.

---

## Purpose

First live delivery with **minimal mutation surface**:

- **1** daily row (job parameter flag)
- **1** metadata `LEDGER ACTION="Create"` (`PW-META-{k12}-{h12}`)
- **1** HTTP Import POST (10s timeout in controlled mode)
- **1** bound claim + **1** ACK
- **Stop** — no agent loop, no auto-retry (`manual_review` on failure)

Assumes **PesoWise Metadata** group already exists (PW-META-HTTP-001 / Phase 5.1 evidence). Controlled mapper **does not** emit `GROUP Create`.

---

## Enable controlled delivery (backend)

Sync job `parameters` must include:

```json
{
  "context_version": 1,
  "e2e_controlled_single_metadata": true
}
```

`run-tally-sync-delivery` then calls `mapPreparedJobItemsControlledE2e()` **only for smoke org** `80ab039f-f9e2-4c76-8b5b-e65b15d66af9`.

Requirements:

- Exactly **one** prepared `daily_project_report` row; otherwise delivery **errors** (409 from edge).
- Production mapping (`mapPreparedJobItems`) **unchanged** when flag absent.

---

## Agent command (future live)

```powershell
.\connector\tally\dist\PesoWise-Tally-Agent.exe run-once `
  --job-id "<NEW_JOB_UUID>" `
  --batch-id "<NEW_BATCH_UUID>"
```

- **0.3.0-agent**
- Bound claim: `connector_claim_delivery_batch_v1(p_job_id, p_batch_id)` — server enforces org via device token.
- Failure / timeout / ambiguous POST: ACK with `e2e_hold: true` → batch **`manual_review`** (no auto-return to `pending`).
- Success: strict parser ok → ACK success → delivery state updated → process exits.
- **Cannot** claim batch 2 in same invocation (single claim, exit).

Normal **`run`** loop unchanged (15s POST cap; failed POST acks without `e2e_hold` unless you use `run-once`).

---

## Migration

`supabase/migrations/20261007170000_tally_e2e_controlled_delivery.sql`

- Batch status **`manual_review`**
- Optional **`p_job_id` / `p_batch_id`** on claim
- **`p_e2e_hold`** on ack

Apply on backup stack before live E2E (not done automatically in this pass).

---

## Representative controlled XML (offline fixture)

Envelope includes `SVCURRENTCOMPANY` = **PesoWise Integration Test** at connector time. Body (one `TALLYMESSAGE`):

- `LEDGER ACTION="Create"` name `PW-META-{k12}-{h12}`
- `PARENT` = **PesoWise Metadata** (group assumed existing — no live probe, no `GROUP Create`)
- UDF `PESOWISE_METADATA_JSON`: `metadata_delivery_key`, `content_hash`, `metadata_revision`, `report_type`, source identity, `PESOWISE_STABLE_KEY` per contract

No employee ledger, cost centre, voucher, ALTER, Load Company, or company enumeration.

---

## GO / NO-GO (offline verification 2026-10-06)

| Check | Result |
|--------|--------|
| Controlled XML = 1 metadata ledger | **PASS** |
| No GROUP / employee / COSTCENTRE / VOUCHER in controlled mode | **PASS** |
| Production mapper unchanged | **PASS** |
| POST timeout ≤ 15s (10s controlled `run-once`) | **PASS** |
| One fetch per `postImportXmlOnce` (success / exception / timeout / network) | **PASS** |
| Timeout/failure → no in-client retry; `run-once` + `e2e_hold` → `manual_review` | **PASS** (code + tests) |
| Bound claim `p_job_id` / `p_batch_id` | **PASS** (migration file + edge) |
| Vitest `tally*` suite | **PASS** (28 files, 259 tests) |
| `PesoWise-Tally-Agent.exe` / `Connector.exe` rebuild | **PASS** — `2026-10-06 17:50:37` local |
| DB migration applied on backup | **PENDING** |
| queue_safe before sync | **PENDING** |

### **Offline: GO** for controlled first live path (code/tests/build).

### **Live E2E: NO-GO** until:

### **GO (conditional)** for live execution **after**:

1. Apply migration `20261007170000…` on backup DB + redeploy Edge functions (claim/ack params).
2. `ssh-verify-queue-safe.mjs` → `queue_safe: true`.
3. Sync with `e2e_controlled_single_metadata: true` and **exactly one** daily row in job.
4. Note **job_id** + **batch_id** from admin/REST (do not use unbound `run`).

---

## Future execution sequence (A–J) — do not run now

| Step | Action |
|------|--------|
| A | `ssh-verify-queue-safe.mjs` |
| B | `Test-NetConnection 127.0.0.1 -Port 9000` (TCP only) |
| C | One Daily Project sync with controlled parameters + single row |
| D | Identify **NEW** `job_id`, **batch_id** (REST/admin, no claim) |
| E | Validate smoke org, `daily_project_report`, batch `message_count=1` |
| F | `PesoWise-Tally-Agent.exe run-once --job-id … --batch-id …` |
| G | Agent exits |
| H | Manual Tally inspect: one new `PW-META-…` under **PesoWise Metadata** |
| I | Backend: batch `delivered` or `manual_review`; job state |
| J | Re-run queue safe; confirm MicroLink + 7 skipped quarantine unchanged |

---

## Related

- `PHASE-05-METADATA-E2E-PREFLIGHT.md` (prior NO-GO for uncontrolled path)
- `TALLY-DOCTOR-C0000005-INCIDENT.md`
