# Phase 5 — metadata revision deploy + E2E prep

**Date:** 2026-10-06  
**Target backend:** `https://pesowise-backup-supabase.unimisk.com` (Coolify `kar0ro1k6jiyfxzzw7acnsza`, host `.46`)  
**Scope:** Tally integration only — migration `20261007150000` + functions `run-tally-sync-delivery`, `tally-connector`.

## Pre-deploy safety

| Check | Result |
|-------|--------|
| Backend URL | `pesowise-backup-supabase.unimisk.com` |
| Unrelated migrations in deploy script | **None** — only `20261007150000_tally_metadata_revision.sql` |
| Unrelated edge functions | **Not deployed** by `deploy-phase5-metadata-revision-only.mjs` |
| Rollback | Re-run prior function folders from git; migration is additive (columns + CREATE OR REPLACE RPCs) |

## Apply migration + deploy (operator)

**Prerequisite:** `Test-NetConnection 192.168.23.46 -Port 22` → `TcpTestSucceeded : True` (VPN/LAN).

```powershell
cd "c:\Users\admin\Desktop\priyanshu intern\test project\peso-bckup-priyanshu"
$env:DEPLOY_SSH_PASSWORD = "<.46 SSH password>"
node scripts/tally-integration/deploy-phase5-metadata-revision-only.mjs
node scripts/tally-integration/probe-backup-edge-functions.mjs
```

Agent shell does not receive your password unless you set it in **the same PowerShell session** before running the script.

Pre/post JSON includes: `last_metadata_revision_col`, `delivery_updates_col`, `expected_rev_fn`, `pending_tally_jobs`, `pending_batches`.

## HTTPS probes (no auth)

```powershell
node scripts/tally-integration/probe-backup-edge-functions.mjs
```

Expect **401** on both functions without credentials.

## Agent build

```powershell
cd connector/tally
npm run package:win
```

Outputs:

- `connector/tally/dist/PesoWise-Tally-Connector.exe`
- `connector/tally/dist/PesoWise-Tally-Agent.exe` (copy alias for installer naming)

Version **0.2.0-agent** — commands: `pair`, `run`, `doctor`.

## E2E report choice

**Daily Project Report** — metadata only, no accounting voucher in mapper (see append-only tests).

Flow: `PHASE-05-CONTROLLED-E2E-RUNBOOK.md`.

## Quarantine

Authenticated dry-run returned **empty** — do not run `QUARANTINE_CONFIRM`.
