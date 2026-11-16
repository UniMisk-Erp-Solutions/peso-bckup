# TallyPrime integration (PesoWise)

| Phase | Document | Status |
|-------|----------|--------|
| 1 | [PHASE-01-REPORT-AUDIT.md](./PHASE-01-REPORT-AUDIT.md) | Complete (audit only) |
| 2 | [PHASE-02-ADMIN-SYNC-FOUNDATION.md](./PHASE-02-ADMIN-SYNC-FOUNDATION.md) | Complete (repo; migration not deployed) |
| 3 | [PHASE-03-DATASET-PREPARATION.md](./PHASE-03-DATASET-PREPARATION.md) | Complete (repo; migration not deployed) |
| 3.5 | [PHASE-03.5-INTEGRATION-VALIDATION.md](./PHASE-03.5-INTEGRATION-VALIDATION.md) | **BLOCKED** (remote E2E; automated PASS) |
| 3.6 | [PHASE-03.6-BACKEND-PIPELINE.md](./PHASE-03.6-BACKEND-PIPELINE.md) | **Code PASS** / remote **BLOCKED** |
| 4 | [PHASE-04-TALLY-MAPPING-XML.md](./PHASE-04-TALLY-MAPPING-XML.md) | **PASS** (mapping + tests; metadata **ledger** model) |
| 5 | [PHASE-05-CONNECTOR-TRANSPORT.md](./PHASE-05-CONNECTOR-TRANSPORT.md) | **Server ready**; connector E2E **NOT VALIDATED** |
| 5.1 | [PHASE-05.1-REAL-TALLY-VALIDATION.md](./PHASE-05.1-REAL-TALLY-VALIDATION.md) | Metadata **ledger** **REAL TALLY PASS**; voucher path **REJECTED** |
| 5 (metadata) | [PHASE-05-METADATA-LEDGER-ARCHITECTURE.md](./PHASE-05-METADATA-LEDGER-ARCHITECTURE.md) | Production serializer **IMPLEMENTED** / tests **PASS** |
| 5.2 | [PHASE-05.2-REPORT-SYNC-ISOLATION.md](./PHASE-05.2-REPORT-SYNC-ISOLATION.md) | **PASS** — one click = one `report_type` |
| 5.3 | [PHASE-05.3-REAL-TALLY-CREATE-SKIP-ALTER.md](./PHASE-05.3-REAL-TALLY-CREATE-SKIP-ALTER.md) | **A + B PASS**; **C NOT PASS** |
| 5.3u | [PHASE-05-METADATA-LEDGER-UPDATE-INVESTIGATION.md](./PHASE-05-METADATA-LEDGER-UPDATE-INVESTIGATION.md) | HTTP Alter investigation (abandoned for production) |
| 5.4 | [PHASE-05-METADATA-APPEND-ONLY-VERSIONS.md](./PHASE-05-METADATA-APPEND-ONLY-VERSIONS.md) | **Production** metadata content updates |
| 5 Live | [PHASE-05-LIVE-TRANSPORT-E2E.md](./PHASE-05-LIVE-TRANSPORT-E2E.md) | **E2E NOT PASS** — pairing + one sync pending |
| **Prod** | [FINAL-PRODUCTION-ARCHITECTURE.md](./FINAL-PRODUCTION-ARCHITECTURE.md) | **LOCKED** |
| Agent | [AGENT-PAIRING-AND-SECURITY.md](./AGENT-PAIRING-AND-SECURITY.md) / [AGENT-PREFLIGHT.md](./AGENT-PREFLIGHT.md) | Pairing + **doctor** |
| Metadata | [METADATA-REVISION-MODEL.md](./METADATA-REVISION-MODEL.md) | **`metadata_revision`** (not hash order) |
| Installer | [UNIVERSAL-INSTALLER-DESIGN.md](./UNIVERSAL-INSTALLER-DESIGN.md) | Plan only |
| E2E runbook | [PHASE-05-CONTROLLED-E2E-RUNBOOK.md](./PHASE-05-CONTROLLED-E2E-RUNBOOK.md) | One metadata sync |
| Deploy | [PHASE-05-DEPLOY-REVISION-E2E.md](./PHASE-05-DEPLOY-REVISION-E2E.md) | Migration + edge deploy script |
| 5.3b | [PHASE-05-ACCOUNTING-VOUCHER-CONTROLLED-TEST.md](./PHASE-05-ACCOUNTING-VOUCHER-CONTROLLED-TEST.md) | Automated **PASS**; real import **NOT RUN** |
| 5.3c | [TALLY-TDL-READ-MODEL-CONTRACT.md](./TALLY-TDL-READ-MODEL-CONTRACT.md) | Contract **COMPLETE** (no TDL files) |
| 6 | *(not started)* | TDL four-report read model (manual) |

## Metadata persistence gates

| Gate | Status |
|------|--------|
| Real TallyPrime 7.1 (ledger + UDF 25001) | **PASS** |
| Production mapping / XML serializer | **IMPLEMENTED** — `npm.cmd run test -- --run tally` **213 passed** |
| Smoke batch quarantine | Dry-run **empty** — nothing to quarantine |
| Connector claim → import → ack | **NOT YET VALIDATED** (pair + run Agent first) |
| Phase 6 TDL | **NOT STARTED** |

**Operational:** Existing Phase 5 smoke batches remain **pending** — do not pair connector or deliver until intentionally handled.
