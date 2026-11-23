# HA RPO / RTO — measured (failover rehearsal 2026-09-25)

**Environment:** PesoWise production rehearsal (`.46` → `.68` promotion)

## RPO (Recovery Point Objective)

| Metric | Value |
|--------|--------|
| Method | Standby replay lag at maintenance + fence |
| Replay age at promotion | **&lt; 15 s** (safety script reported ~7–14 s pre-fence) |
| Final LSN | Primary `0/C4323AE0` / replay ahead at catch-up check |
| **Effective RPO** | **~0–15 s** (async replication, brief Kong stop) |

## RTO (Recovery Time Objective)

| Phase | UTC start | Notes |
|--------|-----------|--------|
| Maintenance (Kong `.46` stop) | 10:35:20 | Blocks app API to old Kong |
| Final catch-up | 10:35:20–41 | Standby current |
| Fence `.46` Postgres | 10:35:41 | |
| Promote `.68` | ~10:35:50 | |
| HAProxy switch | 10:36:20 | |
| **Total maintenance → app path on `.68`** | **~60 s** | Measured wall clock |

## Not included in RTO

- PITR chain migration on `.68` (~6 min base backup)
- `.46` rejoin attempt (~15+ min; **not successful**)
- Full application UAT

## Post-change steady state

- **Primary:** `.68`
- **PITR:** `.68` (`pesowise_pitr`, `pg_receivewal` active)
- **Standby:** `.46` Postgres **off** until rejoin fixed
