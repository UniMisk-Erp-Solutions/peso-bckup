# Manual failover rehearsal — result (2026-09-25)

**Scope:** PesoWise only (`kar0ro1k6jiyfxzzw7acnsza` / `ypwzkftxvvbjfvsll1y3aesk`, `haproxy-pesowise`).

## Final topology (operational)

```text
App → Traefik → HAProxy (.46 host) → Kong 192.168.23.68:54321 → Postgres PRIMARY (.68)
PITR pg_receivewal + slot pesowise_pitr on .68
.46 Postgres: STANDBY (slot pesowise_46_standby, WAL receiver streaming)
Repl proxy on .68: 192.168.23.68:5432 → DB container (pesowise-repl-proxy.service)
```

See **`HA_POST_FAILOVER_COMPLETE.md`** for rejoin details.

## Measured timeline (UTC)

| Event | Timestamp (source) |
|--------|-------------------|
| Maintenance (Kong .46 stop) | `2026-09-25T10:35:20Z` (`/tmp/pesowise-maint-start.txt`) |
| Fence `.46` Postgres | `2026-09-25T10:35:41Z` (`fence-primary-46.sh`) |
| Promote `.68` | ~`2026-09-25T10:35:50Z` (promote script; timeline **2** on `.68`) |
| HAProxy → `.68` | `2026-09-25T10:36:20Z` (`/tmp/pesowise-switch-start.txt`) |
| PITR base backup on `.68` | `20260925T104043Z` under `/var/lib/pesowise-pitr-backup/base/` |
| `.46` standby streaming | ~`2026-09-25T11:31:48Z` (rejoin after repl proxy + pg_hba) |

**Approximate RTO (maintenance → HAProxy switched):** ~**60 seconds**  
**RPO:** Sub-second replay lag at fence (standby was current; no app writes during Kong stop window)

## Completed successfully

- [x] HA lock acquired on `.68`
- [x] `.46` Postgres **fenced** (container stopped) before promotion
- [x] `.68` **promoted** (`pg_is_in_recovery()` → `false`, timeline **2**)
- [x] HAProxy repointed: `server app68 192.168.23.68:54321`
- [x] PITR on new primary: slot `pesowise_pitr`, `pg_receivewal` running, base backup **SUCCESS**
- [x] **`.46` streaming standby** — `finalize-46-standby.sh` + repl proxy + pg_hba `10.0.2.1`
- [x] **`ha_diag.failover_test_events`** applied + diagnostic insert on `.68`
- [x] Split-brain avoided: **only `.68` writable**; **`.46` in recovery**

## Follow-up (non-blocking)

- [ ] **60-minute** extended stability sampling (optional operator cron).
- [ ] PITR WAL freshness WARN on `.68` — monitor; pg_receivewal active.
- [ ] Restart **PesoWise `.46` Kong** only for **failback** rehearsal (separate approval).

## Rollback (if needed)

1. Stop writes; fence `.68` Postgres.
2. Restore HAProxy from `/data/coolify/proxy/haproxy-pesowise/haproxy.cfg.bak-ha-20260925T103620Z`.
3. Start `.46` Postgres from preserved PGDATA (pre-rehearsal copy if retained) **only** if `.68` is fenced.
4. Do **not** run two primaries concurrently.

## Failback

See `MANUAL_FAILOVER_RUNBOOK.md` — **not executed**.

## Readiness

| Criterion | Status |
|-----------|--------|
| Manual promotion proven | **YES** |
| App on new primary | **YES** (HAProxy → `.68`) |
| PITR on new primary | **YES** (WARN on WAL age — monitor) |
| Reversed replication `.68` → `.46` | **YES** |
| **HA rehearsal + rejoin** | **COMPLETE** |
