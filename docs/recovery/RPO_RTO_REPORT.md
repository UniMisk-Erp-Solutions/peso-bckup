# RPO / RTO report

## Production (PesoWise `.46`) — measured 2026-09-25

| Metric | Value | Notes |
|--------|-------|-------|
| **RPO** | **Undefined / worst-case large** | `archive_mode=off`, no `pg_receivewal`, no physical PITR slot |
| **RTO** | **Undefined** | No proven base+WAL restore path on production data |
| Last logical dump | 2026-08-12 | SQL gzip — single point, not PITR |

**Do not invent SLA numbers until production WAL + base backup chain is live.**

## Isolated lab E2E (Docker)

| Phase | Approx duration |
|-------|-----------------|
| Batch A + wait + Batch B | ~15–30s (WAIT_SEC=15) |
| Base backup | ~5s |
| WAL replay to target | ~10–20s |
| **Total lab RTO** | **~45s** (fixture DB only) |

Lab RPO: sub-second (archive_command + switch_wal before delete).
