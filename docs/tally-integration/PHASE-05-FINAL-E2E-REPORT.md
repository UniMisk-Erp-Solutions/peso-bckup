# Phase 5 — Final E2E report

**Last updated:** 2026-10-06 (evening)  
**Overall STATUS:** **PARTIAL** — live Tally HTTP **stopped** after doctor **c0000005** (see `TALLY-DOCTOR-C0000005-INCIDENT.md`). Agent **0.2.1-agent** doctor is TCP + backend only.

---

## Evidence matrix

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Edge worker boot | **PASS** | `probe-backup-edge-functions.mjs` → 401 Unauthorized |
| Connector Edge boot | **PASS** | same probe |
| Import graph / crypto | **PASS** | `npm run test -- tally` → 236 tests |
| Pairing RPC (anon + digest) | **PASS** | `probe-pairing-rpc.mjs` → 400 invalid code (not 401) |
| Queue safety (post-quarantine) | **PASS** (user) | quarantine `updated=7`, `postcheck_ok=true`, global pending=0 |
| Old smoke batches quarantined | **PASS** | `ssh-quarantine-smoke-batches-transaction.mjs` |
| MicroLink untouched | **PASS** (expected) | 3× `prepared` CV 2514, 0 pending batches |
| Agent build | **PASS** | `connector/tally/dist/PesoWise-Tally-Agent.exe` |
| Pairing (smoke org) | **PASS** (this PC) | `%USERPROFILE%\\PesoWise\\TallyConnector\\config.json` → org `80ab039f…`, connector `91cb59dc…`, backend heartbeat OK |
| Doctor | **PARTIAL** | Tally on `:9000` **PASS** after launch; **company context FAIL** until **PesoWise Integration Test** is loaded in TallyPrime |
| Daily Project live sync | **NOT RUN** | set `TALLY_VALIDATE_ADMIN_*` → `trigger-smoke-daily-sync.mjs` or one UI sync |
| Agent claim / Tally delivery / ACK | **NOT RUN** | after sync + `run` |
| Metadata persistence in Tally | **NOT RUN** | manual verify in **PesoWise Integration Test** |
| Global pending batches = 0 after E2E | **NOT RUN** | — |

---

## Completed backend state (do not redo)

- Migrations: metadata revision, `delivery_updates`, quarantine RPC applied on backup DB.
- Edge: `run-tally-sync-delivery`, `tally-connector` deployed; Deno import graph validated.
- Seven legacy smoke pending batches → **`skipped`** (quarantine semantics, audit preserved).

---

## Bootstrap tooling (test only)

| Script | Purpose |
|--------|---------|
| `ssh-verify-queue-safe.mjs` | READ-ONLY global/smoke/MicroLink queue check |
| `ssh-issue-test-pairing-code.mjs` | Issue one pairing code for smoke org via SSH (same hash/TTL as RPC) |
| `_sshPsqlRemote.mjs` | base64 → stdin psql (fixes `\\nSELECT` bug) |

**Not customer pairing.** Production path remains `create_tally_connector_pairing_code_v1` + admin JWT.

---

## One-shot local E2E (this machine — pairing already done)

```powershell
Set-Location "...\peso-bckup-priyanshu"

# Optional remote queue check:
# $env:DEPLOY_SSH_PASSWORD = '<.46 password>'

# Optional sync without UI:
# $env:TALLY_VALIDATE_ADMIN_EMAIL = '...'
# $env:TALLY_VALIDATE_ADMIN_PASSWORD = '...'

powershell -ExecutionPolicy Bypass -File scripts/tally-integration/e2e-smoke-run-local.ps1
```

**Before agent run:** TallyPrime → open **PesoWise Integration Test** (integration/ODBC on port **9000**) → `PesoWise-Tally-Agent.exe doctor` must exit **0** (company + backend + localhost).

**New pairing only if config missing:** `e2e-smoke-bootstrap.ps1` + `pair-smoke-agent.ps1` (anon resolves from Vercel bundle without SSH).

---

## Remaining productization

- Universal installer (`PesoWise-for-Tally-Setup.exe`)
- Background service / scheduled task
- In-app pairing UX (no SSH bootstrap)
- TCP/TDL **PesoWise Reports** menu (manual — Cursor does not edit `.tdl`/`.tcp`)
- Accounting voucher live validation (after metadata E2E PASS; synthetic test expense only)
