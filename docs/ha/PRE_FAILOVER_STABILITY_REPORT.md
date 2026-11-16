# Pre-failover stability report

**Date:** 2026-09-25  
**Requirement:** ≥60 minutes sampling before promotion  
**Monitor:** `scripts/ha/pre-failover-stability-monitor.sh` on `.68`  
**Log on server:** `/tmp/pre-failover-stability.log` · TSV: `/tmp/pre-failover-stability.tsv`

## Phase 1 health (from `.68` verify script)

| Check | Result |
|-------|--------|
| `.68` `pg_is_in_recovery()` | `true` |
| WAL receiver | `streaming` / slot `pesowise_68_standby` |
| Replay age (live) | **&lt; 1 s** on `main` walsender path |
| `system_identifier` | `7673759460013404199` (match) |
| Spot `expenses` | aligned (24713) |
| Stale walsender on `.46` | **Terminated** (empty `application_name`, ~69 min lag) via `cleanup-stale-walsender-46.sh` |

## PITR on `.46`

**Not re-run from this workspace** — requires `hasto@192.168.23.46` SSH. Operator must confirm:

```bash
/home/hasto/peso-bckup-priyanshu/scripts/recovery/check-pitr-health.sh
# OVERALL: PASS
```

## 60-minute window

| Metric | Requirement | Status |
|--------|-------------|--------|
| Disconnect loop | None | Monitor running (180 s interval) |
| WAL missing / auth errors | None | None observed at start |
| Lag | Consistently low | Initial samples sub-second |
| Slot `pesowise_68_standby` | active | **Yes** |

**Do not promote** until TSV completes 60 minutes **and** `.46` PITR PASS is recorded.

## Gate

- [ ] `/tmp/pre-failover-stability.tsv` complete  
- [ ] `check-pitr-health.sh` OVERALL PASS on `.46`  
- [ ] `check-ha-health.sh` OVERALL PASS on `.46`  
- [ ] HA lock acquired  
- [ ] `check-failover-safety.sh` PASS on `.68` with `RUN_LOCALLY=standby`
