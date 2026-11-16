# HA current state audit (read-only)

**Date:** 2026-09-25 (UTC)  
**Scope:** PesoWise production primary `.46`, standby `.68`  
**Changes during audit:** none (read-only). Phase 0 pg_hba persistence applied separately on `.46` only.

| ITEM | .46 (primary) | .68 (standby) | EXPECTED | STATUS | RISK | ACTION REQUIRED |
|------|---------------|---------------|----------|--------|------|-----------------|
| PostgreSQL version | 15.8 (`supabase/postgres:15.8.1.085`) | 15.8 (same image family) | Same major | PASS | Low | None |
| `system_identifier` | `7673759460013404199` | `7673759460013404199` | Match | PASS | Low | None |
| Timeline | 1 | 1 | Match | PASS | Low | None |
| `pg_is_in_recovery()` | `f` (primary) | `t` (standby) | Primary / standby | PASS | Low | None |
| Primary WAL LSN | `0/BF…` (live) | receive `0/92000000`, replay `0/92C27900` | Receive ≈ primary | **FAIL** | **Critical** | **Repair streaming replay on `.68` before any failover** |
| `pg_stat_wal_receiver` | N/A | **0 rows** | Active receiver | **FAIL** | **Critical** | Investigate `.68` replication connection (no live WAL receiver) |
| `pg_last_xact_replay_timestamp` | N/A | **~2026-09-24** (~32h behind) | Seconds behind primary | **FAIL** | **Critical** | Catch up / resync standby |
| `public.expenses` count | **24213** | **22707** | Equal | **FAIL** | **High** | Confirms stale standby data |
| `pg_stat_replication` (.46 view) | `.68` state `streaming`, `write_lsn` ≈ primary | — | Streaming | WARN | Medium | Primary view shows streaming but standby metrics contradict — treat as **not caught up** |
| `replay_lag` (.46 → .68) | **~12–23 min** reported on primary | — | Sub-second | **FAIL** | High | Do not promote until lag near zero |
| Replication slots (.46) | 2 logical + **`pesowise_pitr`** physical | — | PITR + Realtime | PASS | Medium | Do not drop slots |
| `synchronous_standby_names` | empty (async) | — | Async for manual HA | PASS | Low | Document async RPO |
| `wal_level` | logical | — | ≥ replica | PASS | Low | None |
| `max_wal_senders` / slots | 10 / 5 | — | Headroom | PASS | Low | None |
| `hot_standby` | off (primary) | on | on on standby | PASS | Low | None |
| `data_checksums` | off | off | — | WARN | High | **`pg_rewind` unsafe** — use basebackup rejoin path |
| `wal_log_hints` | off | off | — | WARN | High | Same as above |
| `full_page_writes` | on | — | on | PASS | Low | None |
| Disk `/` | ~58% used, ~62 GiB free | ~17% used | Monitor | PASS | Medium | WAL on `.46` `/` |
| DB size (postgres db) | ~243 MB | ~221 MB | Standby ≤ primary | WARN | Medium | Size gap consistent with stale replay |
| Supabase stack | Full Coolify stack (`kar0ro1k6jiyfxzzw7acnsza`) | Full stack (`ypwzkftxvvbjfvsll1y3aesk`) | Replica has services | PASS | Medium | Failover needs endpoint + service plan, not only Postgres |
| `.68` `primary_conninfo` | — | `replicator@192.168.23.46:5432` (password in auto.conf) | Valid repl user | WARN | Medium | **Do not change during audit**; verify credentials vs `.46` `pg_hba` (`replicator` / `192.168.23.68/32`) |
| `standby.signal` | absent | present | present | PASS | Low | None |
| PITR on `.46` | READY (slot + WAL + backups) | N/A | Unchanged | PASS | Low | Do not alter in HA phase |

## Primary replication clients (.46 snapshot)

| client | role | notes |
|--------|------|--------|
| `192.168.23.68` | physical streaming | `supabase_admin` in `pg_stat_replication` |
| `pg_receivewal` | PITR | local socket, slot `pesowise_pitr` |
| Realtime | logical | async |

## BLOCKED for production failover

**Status: NOT SAFE TO PROMOTE** until `.68`:

1. Shows active `pg_stat_wal_receiver` row(s).
2. `pg_last_xact_replay_timestamp` within agreed RPO (e.g. &lt; 30s).
3. Row counts match primary for spot checks (expenses / EFV).
4. Byte lag ≈ 0 at promotion time.

## Phase 0 note (pg_hba persistence)

Live `hba_file`: `/etc/postgresql/pg_hba.conf` (container filesystem).  
Persisted snippet: Docker volume `…/supabase-db-config/_data/pesowise-pitr-pg_hba.snippet` + `apply-pitr-pg_hba-persistent.sh` (reload only).

`.68` replication line preserved: `host replication replicator 192.168.23.68/32 scram-sha-256`.
