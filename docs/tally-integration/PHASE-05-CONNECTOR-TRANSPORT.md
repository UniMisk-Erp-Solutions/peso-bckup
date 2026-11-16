# Phase 5 — Windows connector + TallyPrime transport & acknowledgement

**Status:** **SERVER SIDE READY** — metadata **ledger** persistence **REAL TALLY PASS** (7.1); Agent **doctor/pairing** ready in repo; live connector E2E **NOT YET VALIDATED**  
**Date:** 2026-10-06 (production architecture locked — see `FINAL-PRODUCTION-ARCHITECTURE.md`)

Automated tests **PASS** (**198** tally-scoped). Real Tally proof: **PW-META-MANUAL-001**, **PW-META-HTTP-001** — see **PHASE-05-METADATA-LEDGER-ARCHITECTURE.md** and **PHASE-05.1-REAL-TALLY-VALIDATION.md**. **Do not** deliver existing Phase 5 smoke batches until intentionally re-queued with ledger XML.

---

## 1. Objective

Close the loop from **Sync to Tally** (single click, silent UI) through **prepared → mapped XML → persistent queue → Windows connector → localhost Tally → strict ack → `tally_delivery_state` → job `completed`**, without exposing pipeline state on Reports.

## 2. Architecture

```
Admin → start-tally-sync → run-tally-sync-job → prepared
                              ↓ (async)
                    run-tally-sync-delivery
                              ↓
              tally_sync_delivery_batches (Postgres)
                              ↓ HTTPS outbound
              tally-connector (device token)
                              ↓ HTTP 127.0.0.1:9000
                        TallyPrime
                              ↓ parse response
              connector_ack_delivery_batch_v1
                              ↓
              tally_delivery_state + job completed
```

Tally port **never** exposed to the internet.

## 3. Connector technology

| Choice | Rationale |
|--------|-----------|
| **TypeScript on Node 20** | Same ecosystem as PesoWise; shared parsing patterns |
| **Outbound HTTPS** | Connector polls PesoWise (`tally-connector` edge function) |
| **Local HTTP to Tally** | `127.0.0.1:9000` (configurable) |
| **Packaging** | `pkg` via `connector/tally/scripts/build-win-exe.mjs` → `dist/PesoWise-Tally-Connector.exe` |

## 4. Installation architecture

- Config: `%USERPROFILE%\PesoWise\TallyConnector\config.json`
- Logs: `connector.log` (rotation ~2MB)
- Startup: `connector/tally/scripts/install-startup.ps1` (Scheduled Task at logon)
- **Installer EXE:** build on dev machine — **not built in CI this session**

## 5. Pairing

See **`AGENT-PAIRING-AND-SECURITY.md`**.

1. Admin RPC `create_tally_connector_pairing_code_v1(org)` → one-time code (shown once).
2. Agent: `PesoWise-Tally-Connector.exe pair --url … --anon-key … --code XXXX --company "PesoWise Integration Test"`
3. RPC `exchange_tally_connector_pairing_v1` → `device_token` (stored locally only).

## 5.1 Doctor (read-only preflight)

`PesoWise-Tally-Connector.exe doctor` — see **`AGENT-PREFLIGHT.md`**. No claim/ack/import.

## 6. Device authentication

- Header `X-Connector-Token` on `tally-connector` edge function.
- Server: `resolve_tally_connector_device_v1` (SHA-256 token hash).
- Revoke: `revoke_tally_connector_v1`.

## 7. Organization isolation

Device row is bound to one `organization_id`. Claim/ack RPCs enforce org match.

## 8. Tally company targeting

- `set_tally_org_company_v1(org, name)` (admin).
- Claim response includes `tally_company_name`.
- Connector verifies company list + injects `<SVCURRENTCOMPANY>` before import.
- Mismatch → failed ack (no write).

## 9. Local Tally endpoint

Default `127.0.0.1:9000`; override in `config.json` (`tallyHost`, `tallyPort`).

## 10. Backend delivery queue

Table `tally_sync_delivery_batches`: persistent batches with `pending | claimed | delivered | failed | skipped`, lease expiry, attempt counts.

## 11. Post-prepared orchestration

`run-tally-sync-job` fire-and-forgets `run-tally-sync-delivery` after `complete_tally_sync_preparation_v1`.

Delivery worker: load items + delivery state → `mapPreparedJobItems` → `store_tally_delivery_batches_v1`.

## 12. XML batching

Phase 4 batch size **50** preserved.

## 13. Response parsing

`src/lib/tallyConnector/responseParser.ts` — requires CREATED/ALTERED/DELETED hints and no `LINEERROR`. HTTP 200 alone is **not** success.

## 14. Acknowledgement rules

`connector_ack_delivery_batch_v1` updates `tally_delivery_state` **only** when `p_success=true` and parser-equivalent validation passed on connector before ack.

## 15. Partial batch failure

Failed batch → `pending` retry or `failed` after `max_attempts`. Job → `failed` if any batch failed; otherwise `completed` when none pending/claimed.

## 16. CREATE / SKIP / UPDATE

Unchanged Phase 4 semantics; delivery updates applied per ack payload `delivery_updates` (connector may extend in Phase 5.1).

## 17. Retry / reconciliation

Claim lease expires → batch returns to `pending`. Connector exponential backoff when Tally offline.

**Uncertain timeout:** treat as failure ack → retry; idempotency via delivery keys (Tally may IGNORE duplicates — verify in manual test).

## 18. Offline behavior

Job statuses: `waiting_for_connector`, `delivering`. No `completed` until batches delivered or zero-row skip.

## 19. Heartbeat

`connector_heartbeat_v1` updates `last_seen_at` (ops only, not Reports UI).

## 20. Zero-row jobs

Empty XML batch → `skipped` → job `completed` immediately.

## 21. Automated tests

**162 passed** (`vitest run tally`), including `tallyConnectorPhase5.test.ts`.

## 22. Real TallyPrime tests (Phase 5.1 actuals)

| Test | Automated | Real Tally (2026-10-06) |
|------|-----------|-------------------------|
| Server `.46` deploy | — | **PASS** (see PHASE-05.1 § SERVER DEPLOYMENT) |
| Public `tally-connector` | — | **401** without token |
| localhost:9000 | — | **Reachable** (when Tally integration on) |
| Test company | — | **`PesoWise Integration Test` present** |
| EXE | — | **PASS** — CommonJS + `pkg dist/main.js` (~37.7 MB) |
| Master micro | Mock parser | **PASS** (ledger + `PESOWISE_STABLE_KEY`) |
| Voucher micro | Mock parser | **PASS** (`PesoWise Expense`, balanced lines) |
| Metadata UDF | Mock parser | **BOOTSTRAP TDL REQUIRED** (`PESOWISE_METADATA_JSON`) |
| Pairing / E2E sync | — | **Pending** admin creds + TDL |

Full log: **PHASE-05.1-REAL-TALLY-VALIDATION.md**

| Test | Automated | Real Tally |
|------|-----------|------------|
| Master/voucher/metadata micro import | Mock parser only | **MANUAL REQUIRED** |
| UDF `PESOWISE_METADATA_JSON` round-trip | No | **MANUAL REQUIRED** |
| Accounting two-line journal | No | **MANUAL REQUIRED** |
| Persistence / restart | No | **MANUAL REQUIRED** |

## 23. Files changed (summary)

- `supabase/migrations/20261007120000_tally_connector_phase5.sql`
- Edge: `run-tally-sync-delivery`, `tally-connector`; updated `run-tally-sync-job`
- `supabase/functions/_shared/tallyMapping/` (edge copy)
- `connector/tally/**`
- `src/lib/tallyConnector/responseParser.ts`
- `scripts/tally-integration/remote-deploy-46.mjs`

## 24. Migrations

Apply order after Phase 4:

`20261007120000_tally_connector_phase5.sql`

## 25. Deployment steps

1. Run `remote-deploy-46.mjs` (includes Phase 4 + 5 migrations and new edge functions).
2. Verify tables: `tally_delivery_state`, `tally_sync_delivery_batches`, `tally_connector_devices`.
3. Admin: set Tally company + create pairing code.
4. Windows: pair connector, install startup task, run against **test company only**.

## 26. Rollback

Disable edge functions; revoke connectors; jobs stuck in `waiting_for_connector` can be marked failed manually.

## 27. Known limitations

- Installer not produced on build agent — run `npm run package:win` locally.
- `delivery_updates` in ack not yet auto-built from map decisions (state updates minimal).
- Metadata UDF on **ledgers** validated in Tally 7.1; TDL for four reports **not started** (Phase 6).
- **7 pending smoke-test batches** (legacy voucher-shaped XML if any) must not be claimed/delivered until operator review.

## 28. Phase 6 recommendation

After connector **E2E PASS** with ledger XML: optional MSI installer, admin ops UI for pairing/revoke (not Reports tab), Phase 6 TDL read model.

---

## Manual validation checklist

1. Create company **PesoWise Integration Test** in TallyPrime; enable ODBC/integration port 9000.
2. Deploy migrations + edge to backup Supabase.
3. `create_tally_connector_pairing_code_v1` + `set_tally_org_company_v1`.
4. Pair connector; register scheduled task.
5. Import **one** synthetic master → confirm in Tally.
6. Import **one** expense voucher → confirm debit/credit.
7. Import **one** metadata **ledger** (`PW-META-…`, group **PesoWise Metadata**) → export/read **`PESOWISE_METADATA_JSON`** (document method).
8. Full sync one small report → job `completed`; close browser; data remains in Tally.
9. Stop/start connector — no duplicate vouchers.
10. Stop Tally — sync queues; start Tally — completes without re-click.
